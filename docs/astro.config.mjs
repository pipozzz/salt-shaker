// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://pipozzz.github.io',
  base: '/salt-shaker',
  integrations: [
    starlight({
      title: 'Salt Shaker',
      description: 'A web UI for SaltStack on top of salt-api.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/pipozzz/salt-shaker' }],
      editLink: { baseUrl: 'https://github.com/pipozzz/salt-shaker/edit/main/docs/' },
      sidebar: [
        { label: 'Start here', items: [{ autogenerate: { directory: 'start' } }] },
        { label: 'Deploying', items: [{ autogenerate: { directory: 'deploy' } }] },
        { label: 'Using Salt Shaker', items: [{ autogenerate: { directory: 'guide' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
    }),
  ],
})
