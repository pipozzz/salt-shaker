---
title: Single sign-on
description: Sign in with Keycloak, Entra ID, Google, Authentik, Okta or any OIDC provider.
sidebar: { order: 3 }
---

Salt Shaker supports any OpenID Connect provider. Users can sign in with it, and their role can come from the provider's groups.

## Register the client

Create a confidential OIDC client (one with a client secret) with this redirect URI:

```
<PUBLIC_URL>/api/auth/callback/oidc
```

Then set:

| Variable | |
| --- | --- |
| `OIDC_ISSUER` | issuer URL; discovery is read from `/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | the client credentials |
| `OIDC_NAME` | button label, e.g. `Keycloak` (default `SSO`) |
| `OIDC_SCOPES` | default `openid,profile,email`; add `groups` if your provider needs it |
| `OIDC_ROLE_CLAIM` | claim holding groups or roles, e.g. `groups` or `realm_access.roles` |
| `OIDC_ADMIN_GROUPS` / `OIDC_OPERATOR_GROUPS` / `OIDC_VIEWER_GROUPS` | comma-separated values of that claim, per role |
| `OIDC_DEFAULT_ROLE` | role when nothing matches (see below) |
| `PASSWORD_LOGIN` | `all` (default) or `admins` |

The sign-in uses PKCE and checks the `id_token` nonce.

## Where roles come from

**With `OIDC_ROLE_CLAIM`**, the provider decides. On every sign-in, Salt Shaker reads the claim and gives the user the highest matching role. If someone moves to another group, their role changes at their next sign-in. Users who match no group get `OIDC_DEFAULT_ROLE`, which defaults to `none`, so they can't sign in. Roles of SSO users can't be changed on the **Users** page.

**Without it**, admins assign roles on the **Users** page. New SSO users start with `OIDC_DEFAULT_ROLE`, which defaults to `viewer`. Set it to `none` if an admin should approve each new user first.

Claim paths can be nested, for example `realm_access.roles` in Keycloak.

:::note[Microsoft Entra ID]
Entra ID puts group **object IDs** into the `groups` claim, not names. Either list those IDs in `OIDC_*_GROUPS`, or use app roles and set `OIDC_ROLE_CLAIM=roles`.
:::

## Passwords next to SSO

With `PASSWORD_LOGIN=admins`, only admins can sign in with a password. Everyone else has to use SSO, and admins keep a way in if the provider is down.

The first admin is still created with a password on the first visit.

## Startup without the provider

If the provider can't be reached when the server starts, SSO stays off. The server keeps trying, and SSO turns on once the provider answers. Password sign-in works the whole time.

## Trying it

The [local lab](/salt-shaker/start/quickstart/#full-local-lab) includes a mock provider. Click **Sign in with Lab SSO**, type any username, and add claims such as:

```json
{ "groups": ["salt-operators"] }
```

`salt-admins` and `salt-viewers` work too. With none of these groups, the sign-in is refused.
