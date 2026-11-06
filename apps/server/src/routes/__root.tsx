import { createRootRoute, HeadContent, Outlet, ScriptOnce, Scripts } from '@tanstack/react-router'
import bootAppearance from '@huddle/ui/appearance-boot.js?raw'
import '@huddle/ui/style.css'
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Huddle' },
    ],
  }),
  component: Root,
})
function Root() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ScriptOnce>{bootAppearance}</ScriptOnce>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  )
}
