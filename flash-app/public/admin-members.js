export function mountMembers(container, api) {
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.innerHTML = `<h2>회원 관리</h2>
    <p>아이디는 가입 이메일입니다. 시간은 한국 시간(KST) 기준입니다. 로그인 횟수는 기능 적용 이후의 성공한 로그인과 가입 시 자동 로그인을 포함합니다. 최근 활동은 로그인 상태의 API 이용 기준이며 최대 1분 간격으로 기록됩니다.</p>
    <p>비밀번호는 해시로 안전하게 저장되며 조회할 수 없습니다.</p>
    <form class="order-filters"><label class="field"><span>회원 검색</span><input name="q" type="search" maxlength="254" placeholder="이메일 또는 회원번호"></label><button class="outline-btn" type="submit">검색</button></form>
    <button class="logout" type="button" data-action="refresh">새로고침</button>
    <p role="status" aria-live="polite"></p><div class="order-list"></div>
    <button class="logout" type="button" data-action="previous">이전</button>
    <button class="logout" type="button" data-action="next">다음</button>`;
  container.insertBefore(panel, container.querySelector("section"));
  const form = panel.querySelector("form");
  const status = panel.querySelector('[role="status"]');
  const list = panel.querySelector(".order-list");
  const previous = panel.querySelector('[data-action="previous"]');
  const next = panel.querySelector('[data-action="next"]');
  let page = 1,
    query = "",
    hasMore = false,
    loading = false;
  const date = (value) =>
    value
      ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })
      : "기록 없음";
  function buttons() {
    panel.querySelectorAll("button").forEach((button) => {
      button.disabled = loading;
    });
    previous.disabled = loading || page === 1;
    next.disabled = loading || !hasMore;
  }
  async function refresh(targetPage = page, targetQuery = query) {
    if (loading) return;
    loading = true;
    buttons();
    status.textContent = "회원 정보를 불러오는 중입니다.";
    // Clear stale private records on errors, including expired sessions.
    list.replaceChildren();
    try {
      const result = await api(
        "/api/admin/members?" +
          new URLSearchParams({ page: targetPage, q: targetQuery })
      );
      page = result.page;
      query = targetQuery;
      hasMore = result.hasMore;
      for (const member of result.members) {
        const card = document.createElement("article");
        card.className = "order";
        const title = document.createElement("strong");
        title.textContent = member.email;
        card.append(title);
        for (const [label, value] of [
          ["회원번호", member.id],
          ["권한", member.role === "admin" ? "관리자" : "고객"],
          ["가입일", date(member.created_at)],
          ["최근 로그인", date(member.last_login_at)],
          ["최근 활동", date(member.last_seen_at)],
          ["로그인 횟수 (집계 시작 이후)", member.login_count],
        ]) {
          const row = document.createElement("p");
          row.textContent = `${label}: ${value}`;
          card.append(row);
        }
        list.append(card);
      }
      status.textContent = result.members.length
        ? `${page}페이지 · ${result.members.length}명 (페이지당 최대 50명)`
        : "해당하는 회원이 없습니다.";
    } catch (error) {
      status.textContent = error.message;
      hasMore = false;
    } finally {
      loading = false;
      buttons();
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    refresh(1, new FormData(form).get("q").trim());
  });
  previous.addEventListener("click", () => refresh(page - 1));
  next.addEventListener("click", () => refresh(page + 1));
  panel
    .querySelector('[data-action="refresh"]')
    .addEventListener("click", () => refresh());
  refresh();
}
