export type CatalogCommand = {
  name: string;
  summary: string;
  example: string;
};

export const COMMANDS_CATALOG: CatalogCommand[] = [
  {
    name: "/expert",
    summary: "Find experts across the web.",
    example:
      "/expert labor economist in Canada who can react to inflation data today",
  },
  {
    name: "/scan-site",
    summary: "Find experts on a specific site or organization.",
    example:
      "/scan-site brookings.edu AI policy expert who can explain copyright fights",
  },
  {
    name: "/scout",
    summary: "Get a full story brief on a topic.",
    example: "/scout AI copyright fights in news",
  },
  {
    name: "/digest",
    summary: "Run today's digest now from monitored sources.",
    example: "/digest",
  },
  {
    name: "/sources",
    summary: "Manage the monitored source list.",
    example: "/sources add nytimes.com/section/politics",
  },
  {
    name: "/help",
    summary: "List available commands.",
    example: "/help",
  },
  {
    name: "/clear",
    summary: "Clear this channel's chat history.",
    example: "/clear",
  },
];
