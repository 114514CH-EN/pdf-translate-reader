import { createRoot } from 'react-dom/client';
import App from './App';
import AuthGate from './components/AuthGate';
// typefaces of the interface styles, bundled so the app works fully offline
// (latin subsets only — CJK text falls back to the system fonts)
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
import './styles.css';
import './themes.css';

const container = document.getElementById('root');
if (!container) throw new Error('root 元素不存在');

createRoot(container).render(
  <AuthGate>
    <App />
  </AuthGate>,
);
