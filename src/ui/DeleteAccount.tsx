import React, { useState } from "react";
import { TextInput, View } from "react-native";
import {
  Body,
  Button,
  Card,
  Field,
  Heading,
  Notice,
  Row,
  useTheme,
} from "./components";

export function DeleteAccount({
  email,
  remove,
}: {
  email: string;
  remove(password: string, confirmation: string): Promise<void>;
}) {
  const c = useTheme();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = () => {
    setOpen(false);
    setPassword("");
    setConfirmation("");
    setError("");
  };
  return (
    <Card>
      <Heading small>Delete account</Heading>
      <Body>
        Permanently remove your login, account planner and reminder
        subscriptions. Export a backup first if you want to keep your rota,
        tasks or sleep diary.
      </Body>
      {!open ? (
        <Button
          title="Delete my account"
          danger
          icon="trash-2"
          onPress={() => setOpen(true)}
        />
      ) : (
        <View style={{ gap: 14 }}>
          <Notice error>
            This permanently deletes {email}. It cannot be undone. This device's
            account copies will be cleared; files you exported independently
            remain yours. Limited provider security logs and backups may remain
            for their retention periods.
          </Notice>
          <Body style={{ fontWeight: "600" }}>Current password</Body>
          <TextInput
            accessibilityLabel="Current password for account deletion"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            textContentType="password"
            editable={!busy}
            style={{
              borderWidth: 1,
              borderColor: c.line,
              borderRadius: 12,
              padding: 13,
              color: c.ink,
              backgroundColor: c.card,
              fontSize: 15,
              minHeight: 46,
            }}
          />
          <Field
            label="Type DELETE to confirm"
            value={confirmation}
            onChange={setConfirmation}
          />
          {!!error && <Notice error>{error}</Notice>}
          <Row>
            <Button
              title={
                busy ? "Deleting account…" : "Permanently delete my account"
              }
              danger
              icon="trash-2"
              disabled={busy || !password || confirmation !== "DELETE"}
              onPress={async () => {
                setBusy(true);
                setError("");
                try {
                  await remove(password, confirmation);
                } catch (e) {
                  setPassword("");
                  setError((e as Error).message);
                  setBusy(false);
                }
              }}
            />
            <Button title="Cancel" secondary disabled={busy} onPress={cancel} />
          </Row>
        </View>
      )}
    </Card>
  );
}
