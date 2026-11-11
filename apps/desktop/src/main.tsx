import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { MakeChannel } from './build';
import { App } from './App';
import { inTauri } from './engine';
import './styles.css';

const makeChannel: MakeChannel = <T,>(onMessage: (m: T) => void) => {
  const channel = new Channel<T>();
  channel.onmessage = onMessage;
  return channel;
};

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App invoke={inTauri() ? invoke : null} makeChannel={inTauri() ? makeChannel : null} />
  </StrictMode>,
);
