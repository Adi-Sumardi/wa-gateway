import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

// This module executing means the bundle loaded fine; clear the stale-reload
// guard set by index.html so a genuinely new failure later can still recover.
sessionStorage.removeItem('sendago-stale-bundle-reload')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// The service worker previously used for PWA support cached index.html/assets
// aggressively and kept serving stale bundles after deploys, breaking module
// loading. Unregister any copy still installed in a user's browser and clear
// its caches so everyone converges back to plain network requests.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((reg) => reg.unregister());
  });
  if ('caches' in window) {
    caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
  }
}
