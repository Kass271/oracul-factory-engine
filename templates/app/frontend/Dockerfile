# build context = app root (needs api/openapi.yaml for the generated client)
FROM node:24-alpine AS build
WORKDIR /src
COPY api ./api
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci --no-audit --no-fund
COPY frontend ./frontend
RUN cd frontend && npm run build

FROM nginx:alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/frontend/dist/frontend/browser /usr/share/nginx/html
EXPOSE 80
