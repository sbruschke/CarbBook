import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CarbBookDb } from './db/db';
import { createApi } from './lib/api';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App db={new CarbBookDb()} api={createApi()} />
  </StrictMode>,
);
