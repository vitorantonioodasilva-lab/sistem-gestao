"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  ["/", "Painel"],
  ["/expedicao", "Expedição"],
  ["/produtos", "Produtos e custos"],
  ["/diagnostico", "Diagnóstico"],
  ["/config", "Ajustes"],
];

export default function Nav() {
  const path = usePathname();
  if (path === "/login") return null;
  return (
    <nav>
      {LINKS.map(([href, texto]) => (
        <Link key={href} href={href} className={path === href ? "ativo" : ""}>
          {texto}
        </Link>
      ))}
    </nav>
  );
}
