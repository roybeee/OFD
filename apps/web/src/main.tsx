import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './oda-brand.css';
import { isOdaBrand } from './lib/brand';

if (isOdaBrand) document.documentElement.dataset.brand = 'oda';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}${isOdaBrand ? "oda-sw.js" : "sw.js"}`, { scope: import.meta.env.BASE_URL }).catch(() => undefined);
  });
}
