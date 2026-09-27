"use client";
export default function Home() {
  return (
    <div style={{ height: "100vh" }}>
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
      <iframe
        src="/elfinder/picker.html"
        style={{ width: "100%", height: "100%" }}
      ></iframe>
    </div>
  );
}
