import React from 'react'
import ReactDOM from 'react-dom/client'
import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { App } from './App'
import './style.css'
const rootRoute = createRootRoute({ component: App })
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/' })
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) })
const element = document.getElementById('root')
if (!element) throw new Error('Application root is missing.')
ReactDOM.createRoot(element).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
