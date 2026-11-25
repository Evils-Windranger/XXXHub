import { useId, useState } from "react";
import { MAX_BLOCKED_TAGS, MAX_TAG_LENGTH, normalizeTag, useContentPreferences } from "../../shared/model/contentPreferences";
import { Button, Form, Input } from "../../shared/ui/ios/controls";
import { Modal, Toggle } from "../../shared/ui/ui";
import { IClose } from "../../shared/ui/icons";
import "../../styles/content-preferences.css";
import { tr } from "../../shared/i18n";

export default function ContentPreferencesSettings() {
  const { preferences, storageError, blockTags, unblockTag, setPaused, setHideUntagged, clearBlockedTags, isTagBlocked } = useContentPreferences();
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [clearConfirm, setClearConfirm] = useState(false);
  const errorId = useId();
  const enabled = !preferences.paused;
  const tags = preferences.blockedTags.filter(tag => normalizeTag(tag).includes(normalizeTag(query)));
  const add = () => {
    const tag = value.trim().replace(/\s+/g, " ");
    setMessage("");
    if (!tag) { setError(tr("请输入要屏蔽的完整标签。")); return; }
    if (tag.length > MAX_TAG_LENGTH) { setError(tr("标签最多 {0} 个字符。", MAX_TAG_LENGTH)); return; }
    if (isTagBlocked(tag)) { setError(tr("该标签已在屏蔽列表中。")); return; }
    if (preferences.blockedTags.length >= MAX_BLOCKED_TAGS) { setError(tr("最多保存 {0} 个标签，请先移除不再需要的标签。", MAX_BLOCKED_TAGS)); return; }
    blockTags([tag]); setValue(""); setError(""); setMessage(tr("已屏蔽标签：{0}", tag));
  };
  return <div className="content-preferences-settings">
    <div className="content-preference-switches">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-semibold text-on">{tr("内容屏蔽")}</h3>
          <p className="text-[12px] text-mut mt-1">{enabled ? tr("自动隐藏含已屏蔽标签的内容") : tr("已关闭，当前显示全部内容，已保存标签会保留")}</p>
        </div>
        <Toggle desktop label={tr("内容屏蔽")} on={enabled} onChange={on => setPaused(!on)} />
      </div>
      <div className={`flex items-center gap-3 transition-opacity ${enabled ? "" : "opacity-50"}`}>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-semibold text-on">{tr("隐藏无标签视频")}</h3>
          <p className="text-[12px] text-mut mt-1">{tr("同时隐藏未标注标签的内容")}</p>
        </div>
        <Toggle desktop label={tr("隐藏无标签视频")} disabled={!enabled} on={preferences.hideUntagged} onChange={setHideUntagged} />
      </div>
    </div>
    <Form className="space-y-2" onSubmit={event => { event.preventDefault(); add(); }}>
      <label className="block text-[13px] font-semibold text-on" htmlFor={`${errorId}-add`}>{tr("添加屏蔽标签")}</label>
      <div className="flex flex-wrap gap-2">
        <Input id={`${errorId}-add`} aria-label={tr("添加屏蔽标签")} value={value} onChange={event => { setValue(event.target.value); setError(""); }}
          placeholder={tr("输入完整标签，例如：恐怖")} autoComplete="off" maxLength={MAX_TAG_LENGTH} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
          className="flex-1 w-full min-w-[160px]" />
        <Button type="submit" variant="primary" className="min-h-11 px-4 rounded-(--r-ctl)">{tr("屏蔽标签")}</Button>
      </div>
      {error && <p id={errorId} role="alert" className="text-[13px] text-danger break-words">{error}</p>}
    </Form>
    <div className="content-preference-library">
      <div className="content-preference-library-heading">
        <h3 className="text-[13px] font-semibold text-on">{tr("已屏蔽标签 · {0}", preferences.blockedTags.length)}</h3>
        {preferences.blockedTags.length > 0 && (
          <Button className="min-h-11 px-3 text-danger" onClick={() => setClearConfirm(true)}>{tr("清空标签")}</Button>
        )}
      </div>
      {preferences.blockedTags.length >= 8 && (
        <Input aria-label={tr("搜索已屏蔽标签")} placeholder={tr("按标签名称查找")} value={query} onChange={event => setQuery(event.target.value)} className="w-full" />
      )}
      {tags.length > 0 ? (
        <ul aria-label={tr("已屏蔽标签")} className="content-preference-tag-list" tabIndex={0}>
          {tags.map(tag => <li key={normalizeTag(tag)}>
            <span className="text-[13px] text-on break-words min-w-0">{tag}</span>
            <Button aria-label={tr("取消屏蔽 {0}", tag)} onClick={() => { unblockTag(tag); setMessage(tr("已取消屏蔽：{0}", tag)); }}><IClose size={16} /></Button>
          </li>)}
        </ul>
      ) : (
        <p className="text-[13px] text-mut">{preferences.blockedTags.length ? tr("没有匹配的屏蔽标签。") : tr("还没有屏蔽标签，也可在播放页长按标签添加。")}</p>
      )}
    </div>
    {message && <p role="status" aria-live="polite" className="text-[13px] text-primary break-words">{message}</p>}
    {storageError && <div role="alert" className="rounded-(--r-md) bg-s3 p-3 text-[13px] text-danger">
      <p>{storageError}</p><Button className="mt-2 min-h-11 px-3 text-on" onClick={() => setPaused(preferences.paused)}>{tr("重试保存")}</Button>
    </div>}
    <p className="text-[12px] text-mut leading-relaxed">{tr("按完整标签匹配，仅影响本机展示，不会删除收藏和观看记录。")}</p>
    <Modal open={clearConfirm} onClose={() => setClearConfirm(false)} label={tr("清空屏蔽标签")}>
      <div className="p-5">
        <h2 className="text-[18px] font-bold">{tr("清空屏蔽标签")}</h2>
        <p className="content-preference-confirm-copy mt-3 text-[14px] text-mut">{tr("确认清空全部 {0} 个屏蔽标签？", preferences.blockedTags.length)}</p>
        <div className="mt-4 flex gap-3">
          <Button variant="secondary" className="flex-1 min-h-11" onClick={() => setClearConfirm(false)}>{tr("取消")}</Button>
          <Button variant="danger" className="flex-1 min-h-11" onClick={() => { clearBlockedTags(); setQuery(""); setMessage(tr("已清空屏蔽标签。")); setClearConfirm(false); }}>{tr("确认清空")}</Button>
        </div>
      </div>
    </Modal>
  </div>;
}
