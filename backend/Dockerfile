FROM rust:1-bookworm AS builder
WORKDIR /src

COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src \
    && printf 'fn main() {}\n' > src/main.rs \
    && printf '\n' > src/lib.rs \
    && cargo build --release --locked \
    && rm -rf src

COPY src ./src
COPY sql ./sql
RUN find src -type f -name '*.rs' -exec touch {} + \
    && cargo build --release --locked

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin cardrails

COPY --from=builder /src/target/release/cardrails-api /usr/local/bin/cardrails-api

USER cardrails
EXPOSE 8080
ENV CARDRAILS_BIND=0.0.0.0:8080 RUST_LOG=info
ENTRYPOINT ["/usr/local/bin/cardrails-api"]
