import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './globals.css'

const root = document.getElementById('app')
if (!root) throw new Error('#app not found in index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
