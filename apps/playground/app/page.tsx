"use client";
import { useEffect, useState } from "react";

type Picked = { name: string; url: string };

export default function Home() {
  const [picked, setPicked] = useState<Picked | null>(null);

  // picker.html reports the chosen file with postMessage, from the popup or the iframe.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== "elfinder:pick") {
        return;
      }
      setPicked({ name: event.data.name, url: event.data.url });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 8, display: "flex", gap: 12, alignItems: "center" }}>
        <button
          onClick={() => {
            window.open(
              "/elfinder/picker.html",
              "Picker",
              "width=800,height=600",
            );
          }}
        >
          Open Picker
        </button>
        <span>
          {picked ? (
            <>
              Picked: <a href={picked.url}>{picked.name}</a>
            </>
          ) : (
            "Double-click a file to pick it."
          )}
        </span>
      </div>
      <iframe
        src="/elfinder/picker.html"
        style={{ width: "100%", flex: 1, border: 0 }}
      ></iframe>
    </div>
  );
}
