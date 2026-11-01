# Production image: static UI served by nginx, which also proxies /salt-api/ to rest_cherrypy.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# nginx's entrypoint renders *.template into conf.d with envsubst at start-up
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
ENV SALT_API_URL=http://salt-master:8000
# fills ${NGINX_LOCAL_RESOLVERS} from /etc/resolv.conf for the resolver directive
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
EXPOSE 8080
