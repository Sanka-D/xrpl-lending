"use client";

import { useEffect, useRef } from "react";

export default function LandingPage() {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // Listen for navigation from the iframe (Launch App clicks)
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === "navigate" && e.data.url) {
        window.location.href = e.data.url;
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return (
    <iframe
      ref={iframeRef}
      src="/landing.html"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        border: "none",
        background: "#000",
      }}
      title="Atlas"
    />
  );
}
