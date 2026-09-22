import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Film } from "lucide-react";
import { AppNav, embedded, reportLocation } from "@clawnify/app/client";
import { EditRoute, ProjectsHome, type EditProject } from "./edit";
import { btnGhost } from "./ui";

// Minimal history-based router: `/` = your projects, `/edits/<id>` = the editor.
function useRouter() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, "", to);
    setPath(to);
  }, []);
  return { path, navigate };
}

/**
 * Inside the Clawnify dashboard the projects are listed in the dashboard
 * sidebar, and the open screen is kept in the host URL so a reload returns to
 * it.
 */
function HostNav({ active, path, navigate }: { active: string; path: string; navigate: (to: string) => void }) {
  const [projects, setProjects] = useState<Omit<EditProject, "edl">[]>([]);
  useEffect(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? (r.json() as Promise<Omit<EditProject, "edl">[]>) : []))
      .then(setProjects)
      .catch(() => {});
    reportLocation(window.location.pathname + window.location.search);
  }, [path]);
  return (
    <AppNav
      title="Video"
      icon="video"
      active={active || "home"}
      groups={[
        { items: [{ id: "home", label: "Projects", icon: "video", href: "/", home: true }] },
        {
          label: "Projects",
          items: projects.map((p) => ({ id: `edits/${p.id}`, label: p.name, icon: "camera", href: `/edits/${p.id}` })),
        },
      ]}
      onNavigate={(item) => item.href && navigate(item.href)}
    />
  );
}

export function App() {
  const { path, navigate } = useRouter();
  const id = decodeURIComponent(path.replace(/^\/+|\/+$/g, ""));
  const editId = id.startsWith("edits/") ? id.slice(6) : null;

  return (
    <div className="h-dvh flex flex-col text-foreground">
      {embedded && <HostNav active={id} path={path} navigate={navigate} />}
      {/* Brand row: the app icon is the identity object, and the accent hue
          lives here (plus count badges and the focus ring) and nowhere else.
          The dashboard draws its own, so it is standalone-only. */}
      {!embedded && (
      <header className="flex items-center gap-2 px-5 h-14 border-b border-border bg-surface shrink-0">
        {editId && (
          <button onClick={() => navigate("/")} className={`${btnGhost} -ml-2`}>
            <ArrowLeft className="w-4 h-4" /> Projects
          </button>
        )}
        <span className="grid place-items-center w-7 h-7 rounded-sm bg-accent text-on-accent shrink-0">
          <Film className="w-4 h-4" />
        </span>
        <span className="text-heading-3">OpenVideo</span>
        <span className="text-fine text-faint hidden sm:inline">cut &amp; export video</span>
      </header>
      )}

      {editId ? <EditRoute id={editId} navigate={navigate} /> : <ProjectsHome navigate={navigate} />}
    </div>
  );
}
