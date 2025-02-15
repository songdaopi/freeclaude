/**
 * Rate Limiting Proxy Worker with Sliding Window
 */
const LIMIT = 2; // 120秒内允许2个请求
const WINDOW = 120; // 滑动窗口大小（秒）
const TARGET_HOST = "https://example.com"; // 目标服务器

async function updateRequestStats(ip, path, isSuccess, env) {
    // 获取统计数据
    const statsKey = `${ip}`;
    let stats = await env.ad2api_ip_list.get(statsKey);
    stats = stats
        ? JSON.parse(stats)
        : {
              modelsCount: 0, // /v1/models 的请求次数
              successCount: 0, // 成功请求的次数
              hitMaxLimitCount: 0, // 到达最大限制的次数
          };

    // 更新统计
    if (path === "/v1/models") {
        stats.modelsCount++;
    } else if (!isSuccess) {
        stats.hitMaxLimitCount++;
    } else {
        stats.successCount++;
    }

    // 保存统计数据到 ad2api_ip_list
    await env.ad2api_ip_list.put(statsKey, JSON.stringify(stats));

    return stats;
}

async function checkRateLimit(ip, path, env) {
    // 如果是 /v1/models 路径，不进行限流
    if (path === "/v1/models") {
        await updateRequestStats(ip, path, true, env);
        return { allowed: true };
    }

    const now = Math.floor(Date.now() / 1000);
    const key = `${ip}`;

    // 获取请求历史记录
    let history = await env.ad2api_rate_limits.get(key);
    let timestamps = [];

    if (history) {
        timestamps = JSON.parse(history);
        // 过滤掉超过窗口期的时间戳
        timestamps = timestamps.filter((ts) => now - ts < WINDOW);
    }

    // 检查是否超过限制
    if (timestamps.length >= LIMIT) {
        // 计算最早的请求何时可以过期
        const oldestTimestamp = timestamps[0];
        const waitTime = WINDOW - (now - oldestTimestamp);
        if (waitTime > 0) {
            return { allowed: false, waitTime };
        }
        // 移除最早的请求
        timestamps.shift();
    }

    // 添加新的请求时间戳
    timestamps.push(now);

    // 更新存储
    await env.ad2api_rate_limits.put(key, JSON.stringify(timestamps), {
        expirationTtl: WINDOW,
    });

    return { allowed: true };
}

async function handleRequest(request, env) {
    const ip = request.headers.get("cf-connecting-ip");
    const url = new URL(request.url);

    // 检查速率限制
    const result = await checkRateLimit(ip, url.pathname, env);
    if (!result.allowed) {
        return new Response("Too Many Requests", {
            status: 429,
            headers: {
                "Content-Type": "text/plain",
                "Retry-After": String(result.waitTime),
                "Access-Control-Allow-Origin": "*",
            },
        });
    }

    // 构建目标 URL
    const targetUrl = new URL(TARGET_HOST + url.pathname + url.search);

    // 复制并修改请求头
    const headers = new Headers(request.headers);
    headers.set("Host", new URL(TARGET_HOST).host);

    // 创建新的请求
    const newRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: "follow",
    });

    try {
        // 发送请求到目标服务器
        const response = await fetch(newRequest);
        const isSuccess = response.status !== 500;

        // 更新统计
        await updateRequestStats(ip, url.pathname, isSuccess, env);

        // 如果是500错误，从速率限制历史中移除此次请求
        if (!isSuccess) {
            const key = `${ip}`;
            let history = await env.ad2api_rate_limits.get(key);
            if (history) {
                let timestamps = JSON.parse(history);
                timestamps.pop(); // 移除最后添加的时间戳
                await env.ad2api_rate_limits.put(
                    key,
                    JSON.stringify(timestamps),
                    {
                        expirationTtl: WINDOW,
                    }
                );
            }
        }

        // 创建响应头
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");

        // 返回流式响应
        return new Response(response.body, {
            status: response.status,
            headers: responseHeaders,
        });
    } catch (error) {
        // 处理异常为500错误
        await updateRequestStats(ip, url.pathname, false, env);
        // 从速率限制历史中移除此次请求
        const key = `${ip}`;
        let history = await env.ad2api_rate_limits.get(key);
        if (history) {
            let timestamps = JSON.parse(history);
            timestamps.pop(); // 移除最后添加的时间戳
            await env.ad2api_rate_limits.put(key, JSON.stringify(timestamps), {
                expirationTtl: WINDOW,
            });
        }

        return new Response("Internal Server Error", {
            status: 500,
            headers: {
                "Access-Control-Allow-Origin": "*",
            },
        });
    }
}

export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env);
    },
};
