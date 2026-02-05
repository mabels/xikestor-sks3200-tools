FROM denoland/deno:alpine AS build
WORKDIR /app
COPY deno.json switch-stats.ts vlan-transform.ts ./
RUN deno compile --allow-net --allow-read --allow-env -o switch-stats switch-stats.ts
RUN deno compile --allow-net --allow-read --allow-env --allow-write -o vlan-transform vlan-transform.ts

FROM debian:bookworm-slim
COPY --from=build /app/switch-stats /usr/local/bin/switch-stats
COPY --from=build /app/vlan-transform /usr/local/bin/vlan-transform
ENTRYPOINT ["switch-stats"]
