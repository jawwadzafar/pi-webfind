import { defineConfig } from "vitepress";

export default defineConfig({
  base: "/pi-webfind/",
  title: "pi-webfind",
  description: "Claude Code-style web research for the pi coding agent — free, no API keys",
  head: [["link", { rel: "icon", type: "image/png", href: "/pi-webfind/logo-256.png" }]],
  themeConfig: {
    logo: "/pi-webfind/logo.png",
    siteTitle: "pi-webfind",
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Tools", link: "/guide/tools" },
      { text: "npm", link: "https://www.npmjs.com/package/pi-webfind" },
      { text: "GitHub", link: "https://github.com/jawwadzafar/pi-webfind" },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/jawwadzafar/pi-webfind" }],
  },
});
