import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "dark" | "light";
const STORAGE_KEY = "aira.theme";
const ThemeContext = createContext<{
  theme: Theme;
  selectTheme: (theme: Theme) => void;
} | null>(null);

function readTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#f4f7f6" : "#10171d");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(() => {
    const syncTheme = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === STORAGE_KEY || event.key === null)
      )
        setTheme(readTheme());
    };
    window.addEventListener("storage", syncTheme);
    return () => window.removeEventListener("storage", syncTheme);
  }, []);

  function selectTheme(nextTheme: Theme) {
    applyTheme(nextTheme);
    setTheme(nextTheme);
    // Appearance belongs to this browser only, never to an account or project.
    try {
      localStorage.setItem(STORAGE_KEY, nextTheme);
    } catch {
      /* Still allow changing appearance when browser storage is unavailable. */
    }
  }

  return (
    <ThemeContext.Provider value={{ theme, selectTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function ThemeToggle() {
  const context = useContext(ThemeContext);
  if (!context) return null;
  return (
    <div className="theme-control">
      <span className="theme-label">Appearance</span>
      <div className="theme-options" role="group" aria-label="Color theme">
        <button
          type="button"
          aria-pressed={context.theme === "light"}
          onClick={() => context.selectTheme("light")}
        >
          <Sun size={14} />
          Light
        </button>
        <button
          type="button"
          aria-pressed={context.theme === "dark"}
          onClick={() => context.selectTheme("dark")}
        >
          <Moon size={14} />
          Dark
        </button>
      </div>
    </div>
  );
}
