import React from "react";
import { Alert, Linking } from "react-native";
import { Button, Row } from "./components";

const root = "https://morecreationapps.github.io/wakey-wakey/";

/** Public information is available before login as well as in Settings. */
export function InformationLinks() {
  const open = (page: string) => {
    void Linking.openURL(`${root}${page}`).catch(() =>
      Alert.alert("Page unavailable", "Please try again when you are online."),
    );
  };
  return (
    <Row>
      <Button
        title="Privacy"
        secondary
        small
        icon="shield"
        onPress={() => open("privacy.html")}
      />
      <Button
        title="Support"
        secondary
        small
        icon="help-circle"
        onPress={() => open("support.html")}
      />
    </Row>
  );
}
