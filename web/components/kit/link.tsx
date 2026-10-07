"use client";
// The kit's in-app link: a real <a href> (works without JS, opens in a new tab, keyboard and screen readers see a
// link) whose plain left click navigates with Next's router instead of reloading the app. It is next/link without
// next/link's prefetching module (3.4 KB gzip), which /play cannot afford under the island gate's first-load limit.
// `replace` replaces the history entry (a lateral move). An onClick that calls preventDefault() takes over.
import { useRouter } from "next/navigation";
import type { AnchorHTMLAttributes, MouseEvent } from "react";

export type AppLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; replace?: boolean };

export default function Link({ href, replace, onClick, ...rest }: AppLinkProps) {
  const router = useRouter();
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target === "_blank" || rest.download !== undefined) return;
    e.preventDefault();
    if (replace) router.replace(href);
    else router.push(href);
  };
  return <a {...rest} href={href} onClick={click} />;
}
