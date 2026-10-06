"use client";
import { useMatch } from "@/lib/useMatch";

export default function PlayPage() {
  const { state, me } = useMatch();
  return <main style={{ padding: 16 }}>Phone placeholder: {state.status} me={me}</main>;
}
