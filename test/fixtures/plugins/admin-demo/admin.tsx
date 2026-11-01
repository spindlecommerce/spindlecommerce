import { FlaskConical } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  defineAdminPlugin,
  Detail,
  graphql,
  Link,
  Page,
  PageHeader,
  PluginLink,
  request,
  Skeleton,
  usePlugin,
  useQuery,
  type PluginPageProps,
} from "@ecom/admin";

const DemoQuery = graphql(`
  query AdminDemoSettings {
    plugin(name: "admin-demo") {
      settings {
        key
        value
      }
    }
  }
`);

const HomePage = () => {
  const { title } = usePlugin();
  const query = useQuery({ queryKey: ["admin-demo", "settings"], queryFn: () => request(DemoQuery) });
  const greeting = query.data?.plugin?.settings?.find((s) => s.key === "greeting")?.value;
  return (
    <Page>
      <PageHeader title={title} description="A page from a plugin's admin module, at /admin/plugins/admin-demo." />
      <Card>
        <CardHeader>
          <CardTitle>{query.isLoading ? <Skeleton className="h-5 w-40" /> : `${typeof greeting === "string" ? greeting : "Hello"} from the plugin`}</CardTitle>
        </CardHeader>
        <CardContent className="text-[13px] text-muted-foreground">The greeting is the plugin's Greeting setting. Its widget is on every order.</CardContent>
      </Card>
    </Page>
  );
};

/** At orders/<order ID>: the ID is a global ID, slashes and all, so the link encodes it. */
const OrderPage = ({ params }: PluginPageProps) => (
  <Page>
    <PageHeader back={{ to: "/plugins/admin-demo", label: "Admin demo" }} title="Demo order page" description="A page whose path has a parameter." />
    <Card>
      <CardContent className="pt-5">
        <dl>
          <Detail label="Order ID">
            <span className="font-mono text-xs break-all">{params.id}</span>
          </Detail>
        </dl>
      </CardContent>
    </Card>
  </Page>
);

const OrderWidget = ({ id }: { id: string }) => (
  <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <FlaskConical className="size-4 text-primary" />
        Admin demo
      </CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-1.5 text-[13px]">
      <p className="text-muted-foreground">A widget from a plugin, given this order's ID.</p>
      <PluginLink to={`orders/${encodeURIComponent(id)}`} className="text-primary hover:underline">
        Open the demo order page
      </PluginLink>
      <Link to="/settings/plugins/$name" params={{ name: "admin-demo" }} className="text-primary hover:underline">
        Plugin settings
      </Link>
    </CardContent>
  </Card>
);

/** Dashboard widgets get no props; they show to every staff user who can open the dashboard. */
const DashboardWidget = () => (
  <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <FlaskConical className="size-4 text-primary" />
        Admin demo
      </CardTitle>
    </CardHeader>
    <CardContent className="text-[13px] text-muted-foreground">
      A dashboard widget from a plugin. <PluginLink to="" className="text-primary hover:underline">Open its page</PluginLink>
    </CardContent>
  </Card>
);

export default defineAdminPlugin({
  pages: [
    { path: "", title: "Admin demo", component: HomePage, nav: { label: "Admin demo", icon: FlaskConical, permission: "admin-demo:view", keywords: "fixture test" } },
    { path: "orders/$id", title: "Demo order page", component: OrderPage, permission: "admin-demo:view" },
  ],
  widgets: [
    { zone: "order.detail", component: OrderWidget },
    { zone: "dashboard", component: DashboardWidget, permission: "admin-demo:view" },
  ],
});
