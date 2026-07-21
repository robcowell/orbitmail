import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Content-Security-Policy for the renderer. This is the third layer of defence
// for rendered email HTML, behind the sanitizer (src/utils/sanitizeEmailHtml.ts)
// and the main process's will-navigate blocking; `form-action`, `object-src`,
// `frame-src` and `base-uri` are the directives doing the real work here.
//
// Dev and production differ in one respect that matters: @vitejs/plugin-react
// injects the react-refresh preamble as an *inline* module script, so the dev
// server cannot run under a strict `script-src`. A production build emits only
// external, hashed scripts, so it gets no 'unsafe-inline' and no 'unsafe-eval'
// (the latter is also what triggers Electron's "Insecure Content-Security-Policy"
// warning in dev). Nothing in either mode needs eval.
//
// Shared notes:
//  - `file:` is listed explicitly because a packaged build loads the renderer
//    over file://, where Chromium's `'self'` matching is not dependable.
//  - style-src keeps 'unsafe-inline' in both modes: email bodies are full of
//    inline style attributes, and stripping them would wreck rendering.
//  - img-src/media-src stay open because remote content in mail is currently
//    allowed to load (see TODO.md — there is no block-remote-images option yet).
const CSP_SHARED = [
  "style-src 'self' file: 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' file: data: https://fonts.gstatic.com",
  "img-src 'self' file: data: blob: https: http:",
  "media-src 'self' file: data: https: http:",
  "form-action 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'"
]

const CSP_DEV = [
  "default-src 'self'",
  // Required by the react-refresh preamble the dev server injects inline.
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: wss: https://fonts.googleapis.com https://fonts.gstatic.com",
  ...CSP_SHARED
].join('; ')

const CSP_PROD = [
  "default-src 'self' file:",
  "script-src 'self' file:",
  "connect-src 'self' file: https://fonts.googleapis.com https://fonts.gstatic.com",
  ...CSP_SHARED
].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'orbit-csp',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        return [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: ctx.server ? CSP_DEV : CSP_PROD
            },
            injectTo: 'head-prepend'
          }
        ]
      }
    }
  }
}

// OAuth credentials are read from the project .env at build time and baked into
// the main bundle. Without this the packaged app has no way to get them: it is
// launched from a desktop entry, so dotenv's cwd lookup finds nothing, and .env
// is not in electron-builder's `files`. They stay out of the preload and
// renderer bundles — main process only.
//
// An empty value is not an error here: the app also accepts them from the
// environment or ~/.config/orbit-mail/.env at runtime (see oauth-config.ts).
// The build logs which are missing so a credential-less package is not a
// surprise discovered at sign-in.
function oauthDefines(mode: string): Record<string, string> {
  const env = loadEnv(mode, __dirname, ['GOOGLE_', 'MICROSOFT_'])
  const keys = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'MICROSOFT_CLIENT_ID',
    'MICROSOFT_TENANT_ID'
  ] as const

  const absent = keys.filter((key) => !(env[key] ?? process.env[key] ?? '').trim())
  if (absent.length) {
    console.warn(
      `[orbit-mail] OAuth credentials missing at build time: ${absent.join(', ')}. ` +
        'A package built now will need them supplied at runtime ' +
        '(environment or ~/.config/orbit-mail/.env).'
    )
  }

  return Object.fromEntries(
    keys.map((key) => [
      `__OAUTH_${key}__`,
      JSON.stringify(env[key] ?? process.env[key] ?? '')
    ])
  )
}

export default defineConfig(({ mode }) => ({
  main: {
    define: oauthDefines(mode),
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
        output: {
          // Split rarely-changing vendor code into its own chunks so app-code
          // updates don't invalidate them (better V8 code-cache reuse on reload).
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
              return 'react-vendor'
            }
            return 'vendor'
          }
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    },
    plugins: [react(), cspPlugin()]
  }
}))
