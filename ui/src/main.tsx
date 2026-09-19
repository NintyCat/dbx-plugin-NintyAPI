import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { markComponentKit } from './lib/hostSurface'

// Before the first paint, so a control never flashes as a platform widget.
markComponentKit()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
