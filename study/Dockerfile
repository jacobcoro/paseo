FROM node:22-bookworm-slim
# Paseo process supervision requires ps, and workspace detection requires git.
RUN apt-get update && apt-get install -y --no-install-recommends git procps ca-certificates && rm -rf /var/lib/apt/lists/*
