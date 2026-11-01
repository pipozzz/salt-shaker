FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends procps curl && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir "salt==3007.*" cherrypy
