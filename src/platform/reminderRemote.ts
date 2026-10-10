/** Authenticated device operations. No server key is shipped to the app. */
export async function invokeReminderRemote<T>(
  payload: Record<string, unknown>,
): Promise<T> {
  const { supabase } = await import("../auth/service");
  if (!supabase) throw new Error("The account service is not configured.");
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session || (payload.ownerId && payload.ownerId !== session.user.id))
    throw new Error("Log in again to update this device's alerts.");
  // Capture this owner's bearer before an account change can alter the client.
  const { data, error } = await supabase.functions.invoke("wakey-reminders", {
    body: payload,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (error) {
    throw new Error(
      "Web notification service could not be reached. In-app alerts remain available while this page is open. Refresh the notification status to retry.",
    );
  }
  if (data?.error) throw new Error(String(data.error));
  return data as T;
}
