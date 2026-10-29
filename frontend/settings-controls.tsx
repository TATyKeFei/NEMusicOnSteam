import { DialogButton } from "millennium";
import type { ComponentProps, CSSProperties, PropsWithChildren } from "react";

const BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
  boxSizing: "border-box",
  width: "auto",
  minWidth: 80,
  height: 32,
  minHeight: 32,
  maxHeight: 32,
  margin: 0,
  padding: "0 14px",
  lineHeight: "20px",
  whiteSpace: "nowrap",
};

/** 保留 Steam 的按钮外观与交互，只约束设置项里的尺寸，避免被 Field 拉伸。 */
export function SettingsButton({ style, ...props }: ComponentProps<typeof DialogButton>) {
  return <DialogButton {...props} style={{ ...BUTTON_STYLE, ...style }} />;
}

export function SettingsActions({ children }: PropsWithChildren) {
  return <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, minWidth: 0, maxWidth: "100%" }}>
    {children}
  </div>;
}
