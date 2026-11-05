import { createRoot } from 'react-dom/client';
import App from '../App';
// same typefaces as the main entry, bundled so the app works fully offline
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/newsreader/latin-400.css';
import '@fontsource/newsreader/latin-500.css';
import '@fontsource/newsreader/latin-600.css';
import '@fontsource/newsreader/latin-400-italic.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/space-grotesk/latin-400.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-700.css';
import '@fontsource/nunito/latin-400.css';
import '@fontsource/nunito/latin-600.css';
import '@fontsource/nunito/latin-700.css';
import '@fontsource/cormorant-garamond/latin-500.css';
import '@fontsource/cormorant-garamond/latin-600.css';
import '../styles.css';
import '../themes.css';
import { useViewStore } from '../stores/view';
import { setPetMode } from './mode';

// decided before the first render: the sidebar drops its 阅读助手 tab and the
// pet takes over, so it opens on 笔记 instead
setPetMode(true);
useViewStore.setState({ sidebarTab: 'notes' });

const container = document.getElementById('root');
if (!container) throw new Error('root 元素不存在');

createRoot(container).render(<App />);
