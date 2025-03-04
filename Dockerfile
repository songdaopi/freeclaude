# 构建阶段
FROM golang:1.24-alpine AS builder

# 添加必要的构建依赖
RUN apk add --no-cache git gcc musl-dev

# 设置工作目录
WORKDIR /app

# 设置 Go 环境变量
ENV CGO_ENABLED=0 \
    GOOS=linux \
        GOARCH=amd64 \
            GOTOOLCHAIN=local

            # 复制 go.mod 和 go.sum 文件
            COPY go.mod go.sum ./

            # 下载依赖项
            RUN go mod download

            # 复制源代码
            COPY . .

            # 编译 Go 程序（添加编译优化）
            RUN go build -ldflags="-s -w" -o grok3-openai-proxy

            # 最终运行阶段
            FROM alpine:3.18

            # 添加运行时依赖
            RUN apk add --no-cache ca-certificates tzdata \
                && adduser -D appuser

                # 设置工作目录
                WORKDIR /app

                # 从构建阶段复制编译好的可执行文件
                COPY --from=builder /app/grok3-openai-proxy .

                # 设置文件所有权
                RUN chown -R appuser:appuser /app

                # 切换到非 root 用户
                USER appuser

                # 暴露端口
                EXPOSE 8180

                # 设置启动命令
                ENTRYPOINT ["./grok3-openai-proxy"]
