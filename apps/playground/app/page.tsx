"use client";
export default function Home() {
  return (
    <div style={{ height: "100vh" }}>
      <button
        onClick={() => {
          window.open(
            "/elfinder-static/picker.html",
            "Picker",
            "width=800,height=600",
          );
        }}
      >
        Open Picker
      </button>
      <iframe
        src="/elfinder-static/picker.html"
        style={{ width: "100%", height: "100%" }}
      ></iframe>
    </div>
  );
}
