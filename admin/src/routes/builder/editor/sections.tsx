import { Link } from "@tanstack/react-router";
import { Rows3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/overlay";
import { TEMPLATE_KINDS } from "../model";
import { rawIdOf } from "./api";
import { useEditor, useEditorState } from "./store";

/** A product's or category's own sections: no path; they show where its template places them. */

/** The product or category the sections belong to, as a link to its screen. */
export const OwnerLink = ({ className }: { className?: string }) => {
  const product = useEditorState((s) => s.meta.product);
  const category = useEditorState((s) => s.meta.category);
  if (product) {
    return (
      <Link to="/products/$id" params={{ id: product.id }} className={className}>
        {product.name || "Untitled product"}
      </Link>
    );
  }
  if (category) {
    return (
      <Link to="/categories" search={{ node: rawIdOf(category.id) }} className={className}>
        {category.name || "Untitled category"}
      </Link>
    );
  }
  return null;
};

/** "Product sections · Oxford Shirt": whose sections these are. */
export const SectionsBadge = () => {
  const { contentType } = useEditor();
  const kind = contentType.sectionsFor;
  if (!kind) return null;
  const names = TEMPLATE_KINDS[kind];
  return (
    <Tooltip content={`You are editing one ${names.one}'s own sections: they show on its page where its template places them. Click the name to open the ${names.one}.`}>
      <Badge variant="info" className="max-w-full min-w-0 shrink py-0 text-[11px] leading-4">
        <Rows3 className="shrink-0" />
        <span className="truncate">
          {names.sections} · <OwnerLink className="hover:underline" />
        </span>
      </Badge>
    </Tooltip>
  );
};
