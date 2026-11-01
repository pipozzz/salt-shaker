nginx:
  pkg.installed: []

/var/www/html/index.html:
  file.managed:
    - makedirs: True
    - contents: "<h1>{{ pillar.get('site_name', 'hello') }}</h1>"
