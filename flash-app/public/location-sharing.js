export function mountLocationSharing(doc, nav, send, secure) {
  const button = doc.querySelector("#location-request");
  const status = doc.querySelector("#location-status");
  const preview = doc.querySelector("#location-preview");
  const submit = doc.querySelector("#location-send");
  const cancel = doc.querySelector("#location-cancel");
  let pending = null;
  if (!secure || !nav.geolocation) {
    button.disabled = true;
    status.textContent =
      "이 브라우저에서는 위치를 요청할 수 없습니다. HTTPS 연결과 브라우저 설정을 확인하세요.";
    return;
  }
  button.addEventListener("click", () => {
    pending = null;
    preview.hidden = true;
    button.disabled = true;
    status.textContent =
      "브라우저에서 위치 권한을 선택하세요. 아직 관리자에게 전송되지 않습니다.";
    nav.geolocation.getCurrentPosition(
      (position) => {
        pending = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        };
        doc.querySelector("#location-coordinates").textContent = `위도 ${
          pending.latitude
        } · 경도 ${pending.longitude} · 오차 약 ${Math.round(
          pending.accuracy
        )}m`;
        preview.hidden = false;
        button.disabled = false;
        status.textContent =
          "위치를 확인하세요. 관리자에게 공유하려면 전송을 누르세요.";
      },
      (error) => {
        button.disabled = false;
        status.textContent =
          error.code === 1
            ? "위치 권한이 허용되지 않았습니다. 공유 없이 계속 이용할 수 있습니다."
            : "위치를 확인하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.";
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 0 }
    );
  });
  cancel.addEventListener("click", () => {
    pending = null;
    preview.hidden = true;
    status.textContent = "공유를 취소했습니다. 위치는 전송되지 않았습니다.";
  });
  submit.addEventListener("click", async () => {
    if (!pending) return;
    submit.disabled = button.disabled = cancel.disabled = true;
    try {
      const response = await send("/api/location-shares", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "flash-app",
        },
        body: JSON.stringify({ ...pending, consent: true }),
      });
      if (!response.ok) throw new Error("공유 실패");
      pending = null;
      preview.hidden = true;
      status.textContent =
        "위치를 관리자에게 전송했습니다. 24시간 후 삭제됩니다. 실시간 추적은 하지 않습니다.";
    } catch {
      status.textContent =
        "전송하지 못했습니다. 잠시 후 전송 버튼으로 다시 시도하세요.";
    } finally {
      submit.disabled = button.disabled = cancel.disabled = false;
    }
  });
}
if (typeof document !== "undefined")
  mountLocationSharing(
    document,
    navigator,
    window.fetch.bind(window),
    window.isSecureContext
  );
