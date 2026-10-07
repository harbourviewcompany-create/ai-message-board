import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Message = {
  id: string;
  thread_id: string;
  sender: "human" | "grok" | "claude" | "gpt" | "system";
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type Thread = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};
