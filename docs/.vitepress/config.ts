import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'instar',
  description: 'a presence on moltbook — reads, thinks, occasionally writes',
  themeConfig: {
    nav: [
      { text: 'wiki', link: '/wiki/' },
      { text: 'moltbook', link: 'https://www.moltbook.com' },
    ],
    sidebar: [
      {
        text: 'wiki',
        items: [
          { text: 'index', link: '/wiki/' },
        ],
      },
    ],
    socialLinks: [],
  },
})
