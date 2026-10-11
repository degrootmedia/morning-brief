/*
 * Morning Brief — cloud configuration.
 * The anon key is DESIGNED to be public (Row Level Security protects your data).
 * Never put the service_role key here.
 */
window.MB_CLOUD_CONFIG = {
  url: "https://diigpynvrxqoghhxwdwm.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRpaWdweW52cnhxb2doaHh3ZHdtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2NjE3ODYsImV4cCI6MjEwNzIzNzc4Nn0.k978bNycwKBWk4rSJcDFMdZvt0nq3iCJyYApxZlO_ts",
  proxyFunction: "proxy",
  aiFunction: "ai",
  pullIntervalMs: 60000,
  pushDebounceMs: 1500
};
