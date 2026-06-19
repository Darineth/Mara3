// Web entry point: mounts the Svelte 5 root component into #app (defined in
// index.html). Same bundle whether served by the Mara server or wrapped by the
// Tauri shell.
import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const target = document.getElementById('app');
if (!target) throw new Error('#app mount point not found');

const app = mount(App, { target });

// Exported so HMR/Vite can hold a handle to the running instance.
export default app;
