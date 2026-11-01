# Roll out the baseline, then the web tier, then check everyone answers.
apply_common:
  salt.state:
    - tgt: '*'
    - sls: common

web_tier:
  salt.state:
    - tgt: 'web-*'
    - sls: webserver
    - require:
      - salt: apply_common

ping_all:
  salt.function:
    - name: test.ping
    - tgt: '*'
    - require:
      - salt: web_tier
