/**
 * Shared, pre-styled form + layout primitives. Now that HeroUI's component
 * styles are actually compiled, we use stock HeroUI controls (bordered variant,
 * outside labels) so everything matches the official look in both themes.
 */
import { Input, Textarea, Select, SelectItem, Card, CardBody } from "@heroui/react";

const FIELD = {
  variant: "bordered",
  labelPlacement: "outside",
  radius: "md",
};

export function TextField(props) {
  return <Input {...FIELD} {...props} />;
}

export function NumberField(props) {
  return <Input type="number" {...FIELD} {...props} />;
}

export function AreaField(props) {
  return <Textarea {...FIELD} {...props} />;
}

/**
 * Stock HeroUI Select. Pass `options: [{ key, label, description? }]`, or pass
 * <SelectItem> children directly.
 */
export function SelectField({ options, children, ...props }) {
  return (
    <Select {...FIELD} {...props}>
      {options
        ? options.map((o) => (
            <SelectItem key={o.key} description={o.description}>
              {o.label}
            </SelectItem>
          ))
        : children}
    </Select>
  );
}

/** Standard page header with a title and optional subtitle + right-side action. */
export function PageHeader({ title, subtitle, action, count }) {
  return (
    <div className="flex items-end justify-between gap-4 flex-wrap">
      <div className="space-y-1">
        <h1 className="page-title">
          {title}
          {count != null && <span className="ml-2 text-base font-normal text-default-400">({count})</span>}
        </h1>
        {subtitle && <p className="page-sub max-w-2xl">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/** A titled section card with consistent padding and an optional header action. */
export function SectionCard({ title, desc, action, children, className = "" }) {
  return (
    <Card shadow="sm" className={`border border-default-100 ${className}`}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div className="space-y-0.5">
            {title && <div className="font-semibold text-foreground">{title}</div>}
            {desc && <div className="text-tiny text-default-500 max-w-xl">{desc}</div>}
          </div>
          {action}
        </div>
      )}
      <CardBody className="gap-4 p-5">{children}</CardBody>
    </Card>
  );
}
