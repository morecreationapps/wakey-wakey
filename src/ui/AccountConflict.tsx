import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";
import type { AccountConflictReview } from "../auth/accountStore";
import {
  Body,
  Button,
  Card,
  Heading,
  Icon,
  Label,
  Notice,
  Row,
  useTheme,
} from "./components";

type ConflictSource = "device" | "account";

interface AccountConflictProps {
  review: AccountConflictReview;
  busy: boolean;
  error?: string;
  message?: string;
  onOpenAccount: () => void;
  onRefresh: () => void;
  onDownload: (source: ConflictSource) => void;
  onLogout?: () => void;
}

function VersionCard({
  source,
  review,
  busy,
  onDownload,
}: {
  source: ConflictSource;
  review: AccountConflictReview;
  busy: boolean;
  onDownload: (source: ConflictSource) => void;
}) {
  const { summary } = review[source];
  const device = source === "device";
  return (
    <Card style={{ flexGrow: 1, flexBasis: 280, minWidth: 0 }}>
      <Row>
        <Icon name={device ? "smartphone" : "cloud"} />
        <Label>{device ? "Device copy" : "Account copy"}</Label>
      </Row>
      <Heading small>
        {device ? "Pending edits on this device" : "Saved account version"}
      </Heading>
      <Body>
        {device ? "Based on account revision" : "Account revision"}{" "}
        {summary.revision}
      </Body>
      <View style={{ gap: 5 }}>
        <Body>{summary.rotaEntries} rota entries</Body>
        <Body>{summary.tasks} tasks and appointments</Body>
        <Body>{summary.sleepLogs} sleep logs</Body>
        <Body>
          {summary.onboardingComplete ? "Setup complete" : "Setup in progress"}
        </Body>
      </View>
      <Body muted style={{ fontSize: 12 }}>
        {device
          ? "Includes the pending changes retained in this browser or app."
          : "The newer version currently saved to your account."}
      </Body>
      <Button
        title={device ? "Download device backup" : "Download account backup"}
        icon="download"
        secondary
        disabled={busy}
        onPress={() => onDownload(source)}
      />
    </Card>
  );
}

/** A review is explicit: neither copy is selected or changed on arrival. */
export function AccountConflict({
  review,
  busy,
  error,
  message,
  onOpenAccount,
  onRefresh,
  onDownload,
  onLogout,
}: AccountConflictProps) {
  const c = useTheme();
  const { width } = useWindowDimensions();
  const [confirming, setConfirming] = useState(false);
  const wordmarkWidth = Math.min(280, Math.max(140, width - 124));

  // A refreshed review needs a fresh choice, including when the cloud changed.
  useEffect(() => setConfirming(false), [review.token]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ flexGrow: 1, paddingBottom: 28 }}
      keyboardShouldPersistTaps="handled"
    >
      <View
        style={{
          backgroundColor: c.card,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
          paddingHorizontal: 18,
          paddingVertical: 20,
        }}
      >
        <View
          style={{
            maxWidth: 480,
            width: "100%",
            alignSelf: "center",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
          }}
        >
          <Image
            source={require("../../assets/wakey-wakey-icon.png")}
            style={{ width: 64, height: 64, flexShrink: 0 }}
            resizeMode="contain"
            accessible={false}
          />
          <Image
            source={require("../../assets/wakey-wakey-wordmark.png")}
            style={{
              width: wordmarkWidth,
              height: 68,
              flexShrink: 1,
              minWidth: 0,
            }}
            resizeMode="contain"
            accessibilityLabel="Wakey-Wakey!"
          />
        </View>
      </View>
      <View
        style={{
          maxWidth: 900,
          width: "100%",
          alignSelf: "center",
          padding: width < 480 ? 16 : 24,
          gap: 18,
        }}
      >
        <Card>
          <Row>
            <Icon name="check-circle" />
            <Label>You are signed in</Label>
          </Row>
          <Heading>Your planner has two versions</Heading>
          <Body>
            This device has pending planner edits, and your account has a newer
            saved version. Both copies have been retained. Review them before
            reopening your planner.
          </Body>
          <Notice>
            Your account session is active. The planner is paused to protect the
            two saved copies.
          </Notice>
        </Card>

        {!!error && (
          <View accessibilityLiveRegion="assertive">
            <Notice error>{error}</Notice>
          </View>
        )}
        {!!message && (
          <View accessibilityLiveRegion="polite">
            <Notice>{message}</Notice>
          </View>
        )}

        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "stretch",
            gap: 18,
          }}
        >
          <VersionCard
            source="device"
            review={review}
            busy={busy}
            onDownload={onDownload}
          />
          <VersionCard
            source="account"
            review={review}
            busy={busy}
            onDownload={onDownload}
          />
        </View>

        <Card>
          <Body muted style={{ fontSize: 12 }}>
            These totals help compare the copies. Matching totals can still
            contain different dates, settings or task details. The downloaded
            JSON backups contain each complete planner, including its settings.
          </Body>
          <View accessibilityLiveRegion="polite" style={{ gap: 12 }}>
            {confirming ? (
              <>
                <Heading small>Open the saved account version?</Heading>
                <Body>
                  Both versions will first be kept as recovery backups for your
                  account on this device. Your pending device edits stay in the
                  backups and are not merged into the planner you open.
                </Body>
                <Body>
                  This opens account revision {review.account.summary.revision}.
                  It does not change the saved account version. Download the
                  device backup above if you want a separate copy to keep.
                </Body>
                <Button
                  title="Keep backups and open account"
                  icon="folder"
                  disabled={busy}
                  onPress={onOpenAccount}
                />
                <Button
                  title="Cancel"
                  secondary
                  disabled={busy}
                  onPress={() => setConfirming(false)}
                />
              </>
            ) : (
              <>
                <Heading small>Reopen your planner safely</Heading>
                <Body>
                  You can open the newer account version while keeping your
                  device edits in recovery backups. Review the choice before
                  continuing.
                </Body>
                <Button
                  title="Open saved account version"
                  icon="folder"
                  disabled={busy}
                  onPress={() => setConfirming(true)}
                />
                <Button
                  title="Refresh version comparison"
                  icon="refresh-cw"
                  secondary
                  disabled={busy}
                  onPress={onRefresh}
                />
              </>
            )}
            {busy && (
              <Row>
                <ActivityIndicator color={c.accent} />
                <Body>Checking and preserving your planner copies…</Body>
              </Row>
            )}
          </View>
          {!!onLogout && (
            <Button
              title="Log out"
              icon="log-out"
              secondary
              disabled={busy}
              onPress={onLogout}
            />
          )}
        </Card>
      </View>
    </ScrollView>
  );
}
