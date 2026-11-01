motd:
  file.managed:
    - name: /etc/motd
    - contents: |
        Managed by Salt — {{ grains['id'] }}

base-tools:
  pkg.installed:
    - pkgs: [vim-tiny, htop]
