import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'

// /about is a static landing page (about.html, no JavaScript); vercel.json rewrites it in production.
const aboutRoute = (req, _res, next) => {
  req.url = req.url.replace(/^\/about\/?(?=\?|$)/, '/about.html')
  next()
}

// Run the same first-party handlers during local browser verification.
export default defineConfig(({ mode }) => ({
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        about: fileURLToPath(new URL('./about.html', import.meta.url)),
      },
    },
  },
  plugins: [react(), {
    name: 'cardrails-about-route',
    configureServer(server) { server.middlewares.use(aboutRoute) },
    configurePreviewServer(server) { server.middlewares.use(aboutRoute) },
  }, {
    name: 'cardrails-local-api',
    configureServer(server) {
      Object.assign(process.env, loadEnv(mode, process.cwd(), ''))
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost')
        const match = /^\/api\/v1\/(inventory|sales|catalog|developer|ebay|photo|capture|recognize|channels|sync|listings|oauth|hooks)$/.exec(url.pathname)
        if (!match) return next()
        res.status = code => { res.statusCode = code; return res }
        res.json = data => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(data)); return res }
        try {
          req.query = Object.fromEntries(url.searchParams)
          if (match[1] === "ebay") req.query.resource = "ebay-draft"
          if (req.method === 'POST' && match[1] !== 'hooks') {
            let body = ''
            for await (const chunk of req) { body += chunk; if (body.length > 3000000) return res.status(413).json({error:'Photo is too large.'}) }
            req.body = JSON.parse(body || '{}')
          }
          const { default: handler } = await server.ssrLoadModule(`/api/v1/${match[1] === "ebay" ? "developer" : match[1]}.js`)
          await handler(req,res)
        } catch { res.status(500).json({error:'Local API request failed.'}) }
      })
    },
  }],
}))
