import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Modal,
  TextInput,
  ScrollView,
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

// Simple disaster stock inventory app
// - White UI
// - Persistent storage via AsyncStorage
// - Add item: name, icon (emoji), expiry date (YYYY-MM-DD)
// - If no icon selected, shows ❓
// - Detail view with delete
// - Color-coded border based on time to expiry
// - Schedules local notifications at offsets relative to expiry

const STORAGE_KEY = '@stock_items_v1';

// Icons organized by category. UI unchanged; only the ordering is controlled here.
const ICONS_BY_CATEGORY = {
  '消耗品': ['💧','🧃','🥛','🥤'],
  '食料品': ['🍚','🥫','🍱','🍜','🍞','🥐','🥖','🍪','🍬','🍫','🍜','🍲','🍝','🍳','🍘','🫘'],
  '道具': ['🛠️','✂️','🪣','🪚','🪓','🧯'],
  '衛生': ['💊','🩹','🧰'],
  '電源': ['🔋','🔌','⛽'],
  '照明': ['🔦','📻','🪔','🕯️','🪭'],
  '衣類': ['🧥','🎒','🩴','👟'],
  'その他': ['🧻','📦','📰','🗞️','💵','🪙','🗑️','🛍️','🟦','🧨','🥣','🧤','🪥']
};

// Build ICONS_ALL with '?' first, then categories in the chosen order, while removing duplicates.
const CATEGORY_ORDER = ['消耗品','食料品','道具','衛生','電源','照明','衣類','その他'];
const ICONS_ALL = Array.from(new Set(['❓', ...CATEGORY_ORDER.flatMap((cat) => ICONS_BY_CATEGORY[cat] || [])]));
// first 12 icons are the visible default row; the rest go to "もっと見る"
const VISIBLE_ICONS = ICONS_ALL.slice(0, 12);
const MORE_ICONS = ICONS_ALL.slice(12);

const { width: WINDOW_WIDTH } = Dimensions.get('window');
const MOBILE_MAX_WIDTH = 420;
const APP_CONTENT_WIDTH = Math.min(WINDOW_WIDTH, MOBILE_MAX_WIDTH);
const GRID_PADDING = 16; // matches grid paddingHorizontal used in styles
const ITEM_MARGIN = 8; // margin on each side of itemBoxLarge
// show 3 columns per row
const COLUMNS = 3;
// compute available width: screen width minus grid padding (left+right) minus total horizontal margins for all items
const totalHorizontalMargins = COLUMNS * ITEM_MARGIN * 2; // each item has left+right margin
const ITEM_BOX_LARGE_WIDTH = Math.floor((APP_CONTENT_WIDTH - GRID_PADDING * 2 - totalHorizontalMargins) / COLUMNS);


// notification offsets in days relative to expiry
const OFFSETS = [30, 7, 3, 2, 1, 0, -7]; // days before (negative = after expiry)

function daysUntilExpiry(expiryIso) {
  if (!expiryIso) return Infinity;
  const now = new Date();
  const exp = new Date(expiryIso + 'T00:00:00');
  const diff = (exp - now) / (1000 * 60 * 60 * 24);
  return Math.ceil(diff);
}

function getBorderColor(expiryIso) {
  const days = daysUntilExpiry(expiryIso);
  if (days <= 3) return '#ff4d4f'; // red
  if (days <= 7) return '#ff8c00'; // orange
  if (days <= 30) return '#ffd24d'; // yellow
  return '#ccc';
}

export default function App() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState('list'); // 'list' | 'add' | 'detail'
  const [editingItem, setEditingItem] = useState(null);

  // add form state
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('❓');
  // expiry split into year/month/day
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [monthModalVisible, setMonthModalVisible] = useState(false);
  const [dayModalVisible, setDayModalVisible] = useState(false);
  const [moreIconsModalVisible, setMoreIconsModalVisible] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmAction, setConfirmAction] = useState(null);

  function showNotice(title, message) {
    setNotice({ title, message });
  }

  function closeNotice() {
    setNotice(null);
  }

  function confirmDelete(item) {
    setConfirmAction({
      title: '削除',
      message: `${item.name} を削除しますか？`,
      confirmText: '削除',
      onConfirm: async () => {
        if (item.notificationIds && item.notificationIds.length) {
          for (const nid of item.notificationIds) {
            try {
              await Notifications.cancelScheduledNotificationAsync(nid);
            } catch (e) {}
          }
        }
        const next = items.filter((it) => it.id !== item.id);
        await saveItems(next);
        setScreen('list');
        setConfirmAction(null);
      },
      onCancel: () => setConfirmAction(null),
    });
  }

  useEffect(() => {
    loadItems();
    requestNotificationPermissions();
  }, []);

  async function requestNotificationPermissions() {
    try {
      const { status } = await Notifications.getPermissionsAsync();
      if (status !== 'granted') {
        const response = await Notifications.requestPermissionsAsync();
        // ignore if denied; app still functions without notifications
      }
    } catch (e) {
      console.warn('Notification permission error', e);
    }
  }

  async function loadItems() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      setItems(parsed);
    } catch (e) {
      console.warn('Failed to load items', e);
    } finally {
      setLoading(false);
    }
  }

  async function saveItems(nextItems) {
    setItems(nextItems);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(nextItems));
    } catch (e) {
      console.warn('Failed to save items', e);
    }
  }

  async function scheduleNotificationsForItem(item) {
    if (!item.expiry) return [];
    const scheduledIds = [];
    for (const offset of OFFSETS) {
      const base = new Date(item.expiry + 'T09:00:00'); // notify at 9:00 local time
      // subtract offset days: offset=30 means expiry - 30
      const notifyDate = new Date(base.getTime());
      notifyDate.setDate(base.getDate() - offset);
      const now = new Date();
      if (notifyDate <= now) continue; // don't schedule past notifications
      try {
        const id = await Notifications.scheduleNotificationAsync({
          content: {
            title: `期限間近: ${item.name}`,
            body: `期限まであと ${Math.ceil((new Date(item.expiry+'T00:00:00') - now)/(1000*60*60*24))} 日です`,
            data: { itemId: item.id },
          },
          trigger: notifyDate,
        });
        scheduledIds.push(id);
      } catch (e) {
        console.warn('Failed to schedule', e);
      }
    }
    return scheduledIds;
  }

  async function addItem() {
    if (!name.trim()) {
      showNotice('入力エラー', '名前を入力してください');
      return;
    }
    // build expiry from year/month/day if provided
    let expiryIso = '';
    if (year.trim() || month || day) {
      if (!year.match(/^\d{4}$/)) {
        showNotice('入力エラー', '年はYYYYの形式で入力してください');
        return;
      }
      if (!month) {
        showNotice('入力エラー', '月を選択してください');
        return;
      }
      if (!day) {
        showNotice('入力エラー', '日を選択してください');
        return;
      }
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      expiryIso = `${year}-${mm}-${dd}`;
    }

    if (editingItem) {
      // update existing
      const updated = { ...editingItem, name: name.trim(), icon: icon || '❓', expiry: expiryIso || null };
      // cancel old notifications
      if (editingItem.notificationIds && editingItem.notificationIds.length) {
        for (const nid of editingItem.notificationIds) {
          try { await Notifications.cancelScheduledNotificationAsync(nid); } catch (e) {}
        }
      }
      const ids = await scheduleNotificationsForItem(updated);
      updated.notificationIds = ids;
      const next = items.map((it) => (it.id === updated.id ? updated : it));
      await saveItems(next);
      setEditingItem(null);
      setScreen('list');
      return;
    }

    const id = Date.now().toString();
    const newItem = { id, name: name.trim(), icon: icon || '❓', expiry: expiryIso || null, notificationIds: [] };
    // schedule notifications
    const ids = await scheduleNotificationsForItem(newItem);
    newItem.notificationIds = ids;
    const next = [newItem, ...items];
    await saveItems(next);
    // reset form and go back
    setName('');
    setIcon('❓');
    setYear(''); setMonth(''); setDay('');
    setScreen('list');
  }

  async function deleteItem(item) {
    confirmDelete(item);
  }

  function openAdd() {
    setEditingItem(null);
    setName('');
    setIcon('❓');
    setYear(''); setMonth(''); setDay('');
    setScreen('add');
  }

  function openDetail(item) {
    setEditingItem(item);
    setScreen('detail');
  }

  useEffect(() => {
    // when entering add screen prefill fields if editing
    if (screen === 'add') {
      if (editingItem) {
        setName(editingItem.name || '');
        setIcon(editingItem.icon || '❓');
        if (editingItem.expiry) {
          const parts = editingItem.expiry.split('-');
          setYear(parts[0] || '');
          setMonth(parts[1] ? Number(parts[1]) : '');
          setDay(parts[2] ? Number(parts[2]) : '');
        } else {
          setYear(''); setMonth(''); setDay('');
        }
      }
    }
  }, [screen, editingItem]);

  const renderOverlayModals = () => (
    <>
      <Modal visible={!!notice} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.noticeCard}>
            <Text style={styles.noticeTitle}>{notice?.title || 'お知らせ'}</Text>
            <Text style={styles.noticeText}>{notice?.message}</Text>
            <TouchableOpacity style={styles.noticeButton} onPress={closeNotice}>
              <Text style={styles.noticeButtonText}>閉じる</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={!!confirmAction} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.noticeCard}>
            <Text style={styles.noticeTitle}>{confirmAction?.title || '確認'}</Text>
            <Text style={styles.noticeText}>{confirmAction?.message}</Text>
            <View style={styles.confirmRow}>
              <TouchableOpacity style={[styles.noticeButton, styles.cancelButton]} onPress={confirmAction?.onCancel || (() => setConfirmAction(null))}>
                <Text style={styles.noticeButtonText}>キャンセル</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.noticeButton, styles.deleteButton]} onPress={confirmAction?.onConfirm || (() => setConfirmAction(null))}>
                <Text style={styles.noticeButtonText}>{confirmAction?.confirmText || '確認'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );

  const visibleIconRows = [];
  for (let i = 0; i < VISIBLE_ICONS.length; i += 3) {
    visibleIconRows.push(VISIBLE_ICONS.slice(i, i + 3));
  }

  const allIconRows = [];
  for (let i = 0; i < ICONS_ALL.length; i += 3) {
    allIconRows.push(ICONS_ALL.slice(i, i + 3));
  }

  const totalVisibleIcons = VISIBLE_ICONS.length;

  if (loading) {
    return (
      <SafeAreaView style={[styles.safe, styles.appShell]}>
        <View style={styles.center}><Text>読み込み中...</Text></View>
      </SafeAreaView>
    );
  }

  // List screen
  if (screen === 'list') {
    return (
      <SafeAreaView style={[styles.safe, styles.appShell]}>
        <View style={styles.header}>
          <Text style={styles.title}>備蓄品一覧</Text>
          <TouchableOpacity style={styles.addButton} onPress={openAdd}>
            <Text style={styles.addButtonText}>＋</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.grid}>
          {items.length === 0 && <Text style={styles.empty}>まだ登録されていません。＋ボタンで追加してください。</Text>}

          {/* Group items by icon */}
          {(() => {
            const groups = {};
            for (const it of items) {
              const key = it.icon || '❓';
              if (!groups[key]) groups[key] = [];
              groups[key].push(it);
            }
            // sort items within group by days until expiry (ascending)
            for (const k of Object.keys(groups)) {
              groups[k].sort((a,b)=>{
                const da = daysUntilExpiry(a.expiry);
                const db = daysUntilExpiry(b.expiry);
                return da - db;
              });
            }
            // determine group order by earliest creation (min id numeric) among group's items
            const groupEntries = Object.entries(groups).map(([iconKey, arr])=>{
              const minId = Math.min(...arr.map(it=>Number(it.id)||Infinity));
              return { iconKey, items: arr, minId };
            });
            groupEntries.sort((a,b)=>a.minId - b.minId);

            return groupEntries.map(group=> {
              const itemWidth = group.items.length === 1 ? '100%' : group.items.length === 2 ? '48%' : '30%';
              return (
                <View key={group.iconKey} style={styles.groupBlock}>
                  <Text style={styles.groupTitle}>{group.iconKey}</Text>
                  <View style={styles.groupRow}>
                    {group.items.map(it=>{
                      const borderColor = getBorderColor(it.expiry);
                      return (
                        <TouchableOpacity key={it.id} style={[styles.itemBoxLarge, { borderColor, width: itemWidth, maxWidth: ITEM_BOX_LARGE_WIDTH }]} onPress={() => openDetail(it)}>
                          <View style={styles.iconBgLargeBox}>
                            <Text style={styles.iconTextLarge}>{it.icon || '❓'}</Text>
                          </View>
                          <Text style={styles.itemName} numberOfLines={1}>{it.name}</Text>
                          <Text style={styles.itemExpiry}>{it.expiry ? it.expiry : '期限なし'}</Text>
                          {daysUntilExpiry(it.expiry) < 0 && <Text style={styles.expiredText}>期限切れ</Text>}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              );
            });
          })()}

        </ScrollView>

        <StatusBar style="dark" />
        {renderOverlayModals()}
      </SafeAreaView>
    );
  }

  // Add screen
  if (screen === 'add') {
    const isEditing = !!editingItem;
    return (
      <SafeAreaView style={[styles.safe, styles.appShell]}>
        <View style={styles.addHeader}>
          <TouchableOpacity onPress={() => { setEditingItem(null); setScreen('list'); }}><Text style={styles.close}>✕</Text></TouchableOpacity>
          <Text style={styles.title}>{isEditing ? '備蓄品を編集' : '備蓄品を追加'}</Text>
          <View style={{width:40}} />
        </View>

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{flex:1}}>
        <ScrollView contentContainerStyle={{paddingBottom:40}} keyboardShouldPersistTaps="handled">
          <View style={styles.form}>
            <Text style={styles.label}>名前</Text>
            <TextInput value={name} onChangeText={setName} style={styles.input} placeholder="水" placeholderTextColor="#b0b7c3" />

            <Text style={styles.label}>アイコンを選択（未選択は❓）</Text>
            <View style={styles.iconGridWrap}>
              {visibleIconRows.map((row, rowIndex) => (
                <View key={`visible-row-${rowIndex}`} style={styles.iconRowLarge}>
                  {row.map((ic) => (
                    <TouchableOpacity key={ic} style={[styles.iconSelectLarge, icon === ic && styles.iconSelected]} onPress={() => setIcon(ic)}>
                      <Text style={styles.iconTextLarge}>{ic}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ))}
              {MORE_ICONS.length > 0 && (
                <View style={styles.iconRowLarge}>
                  <TouchableOpacity style={[styles.iconSelectLarge, styles.moreButtonLarge]} onPress={() => setMoreIconsModalVisible(true)}>
                    <Text style={styles.moreText}>もっと見る</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {/* More icons modal */}
            <Modal visible={moreIconsModalVisible} animationType="slide" transparent={true}>
              <View style={styles.modalOverlay}>
                <View style={[styles.modalContent, {width:320}]}> 
                  <Text style={styles.modalTitle}>アイコンを選択</Text>
                  <ScrollView contentContainerStyle={styles.moreIconsGrid}>
                    {allIconRows.map((row, rowIndex) => (
                      <View key={`all-row-${rowIndex}`} style={styles.iconRowLarge}>
                        {row.map((ic) => (
                          <TouchableOpacity key={ic} style={[styles.iconSelect, icon === ic && styles.iconSelected]} onPress={() => { setIcon(ic); setMoreIconsModalVisible(false); }}>
                            <Text style={styles.iconText}>{ic}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    ))}
                  </ScrollView>
                  <TouchableOpacity onPress={()=>setMoreIconsModalVisible(false)} style={styles.modalClose}><Text>閉じる</Text></TouchableOpacity>
                </View>
              </View>
            </Modal>

            <Text style={styles.label}>賞味/使用期限</Text>
            <View style={styles.expiryRow}>
              <TextInput value={year} onChangeText={setYear} style={[styles.input, styles.yearInput]} placeholder="年" placeholderTextColor="#b0b7c3" keyboardType="numeric" maxLength={4} returnKeyType="done" returnKeyLabel="確定" onSubmitEditing={() => Keyboard.dismiss()} />

              <TouchableOpacity style={[styles.input, styles.pickerInput]} onPress={() => setMonthModalVisible(true)}>
                <Text style={styles.pickerText}>{month ? String(month).padStart(2,'0') : '月'}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.input, styles.pickerInput]} onPress={() => setDayModalVisible(true)}>
                <Text style={styles.pickerText}>{day ? String(day).padStart(2,'0') : '日'}</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.saveButton} onPress={addItem}>
              <Text style={styles.saveButtonText}>{isEditing ? '保存' : '作成'}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
        </KeyboardAvoidingView>

        {/* Month modal */}
        <Modal visible={monthModalVisible} animationType="slide" transparent={true}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>月を選択</Text>
              <ScrollView>
                {Array.from({length:12}).map((_,i)=>{
                  const m = i+1;
                  return (
                    <TouchableOpacity key={m} style={styles.modalItem} onPress={()=>{ setMonth(m); setMonthModalVisible(false); }}>
                      <Text style={styles.modalItemText}>{String(m).padStart(2,'0')}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <TouchableOpacity onPress={()=>setMonthModalVisible(false)} style={styles.modalClose}><Text>閉じる</Text></TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Day modal */}
        <Modal visible={dayModalVisible} animationType="slide" transparent={true}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>日を選択</Text>
              <ScrollView>
                {Array.from({length:31}).map((_,i)=>{
                  const d = i+1;
                  return (
                    <TouchableOpacity key={d} style={styles.modalItem} onPress={()=>{ setDay(d); setDayModalVisible(false); }}>
                      <Text style={styles.modalItemText}>{String(d).padStart(2,'0')}</Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
              <TouchableOpacity onPress={()=>setDayModalVisible(false)} style={styles.modalClose}><Text>閉じる</Text></TouchableOpacity>
            </View>
          </View>
        </Modal>
        {renderOverlayModals()}
      </SafeAreaView>
    );
  }

  // Detail screen
  if (screen === 'detail' && editingItem) {
    return (
      <SafeAreaView style={[styles.safe, styles.appShell]}>
        <View style={styles.addHeader}>
          <TouchableOpacity onPress={() => setScreen('list')}><Text style={styles.close}>✕</Text></TouchableOpacity>
          <Text style={styles.title}>詳細</Text>
          <View style={{width:40}} />
        </View>

        <View style={styles.detail}>
          <View style={[styles.iconBgLarge, { borderColor: getBorderColor(editingItem.expiry) }]}>
            <Text style={styles.iconTextLarge}>{editingItem.icon || '❓'}</Text>
          </View>
          <Text style={styles.detailName}>{editingItem.name}</Text>
          <Text style={styles.detailExpiry}>{editingItem.expiry ? `期限: ${editingItem.expiry}` : '期限なし'}</Text>

          <View style={styles.detailButtons}>
            <TouchableOpacity style={styles.editButton} onPress={() => { setName(editingItem.name); setIcon(editingItem.icon || '❓'); if (editingItem.expiry) { const parts = editingItem.expiry.split('-'); setYear(parts[0]); setMonth(Number(parts[1])); setDay(Number(parts[2])); } else { setYear(''); setMonth(''); setDay(''); } setScreen('add'); }}>
              <Text style={styles.editButtonText}>編集</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.deleteButton} onPress={() => deleteItem(editingItem)}>
              <Text style={styles.deleteButtonText}>削除</Text>
            </TouchableOpacity>
          </View>
        </View>

        {renderOverlayModals()}
      </SafeAreaView>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#eaf3ff' },
  appShell: {
    maxWidth: 420,
    width: '100%',
    alignSelf: 'center',
    backgroundColor: '#f5f9ff',
    borderLeftWidth: Platform.OS === 'web' ? 1 : 0,
    borderRightWidth: Platform.OS === 'web' ? 1 : 0,
    borderColor: '#dfeafc',
    shadowColor: '#0047b3',
    shadowOpacity: Platform.OS === 'web' ? 0.08 : 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, backgroundColor: '#ffffff', borderBottomWidth: 1, borderBottomColor: '#e5edf7' },
  addHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, backgroundColor: '#ffffff', borderBottomWidth: 1, borderBottomColor: '#e5edf7' },
  title: { fontSize: 20, color: '#000', fontWeight: '600' },
  addButton: { backgroundColor: '#007aff', width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  addButtonText: { color: '#fff', fontSize: 28, lineHeight: 30 },
  grid: { paddingHorizontal: 16, paddingBottom: 40 },
  groupBlock: { marginBottom: 18 },
  groupTitle: { fontSize: 16, fontWeight: '600', color: '#333', marginLeft: 6, marginBottom: 8 },
  groupRow: { flexDirection: 'row', flexWrap: 'wrap', width: '100%', justifyContent: 'flex-start' },
  itemBox: { width: 84, height: 110, backgroundColor: '#fff', margin: 8, borderRadius: 8, alignItems: 'center', padding: 8, borderWidth: 2 },
  /* larger item for initial screen */
  itemBoxLarge: { width: '30%', minWidth: 88, height: 152, backgroundColor: '#fff', marginVertical: 6, marginRight: 8, borderRadius: 8, alignItems: 'center', padding: 8, borderWidth: 2 },
  iconBg: { width: 56, height: 56, backgroundColor: '#fff', borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  iconBgLargeBox: { width: 72, height: 72, backgroundColor: '#fff', borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 28 },
  iconTextLarge: { fontSize: 36 },
  iconGridWrap: { width: '100%', overflow: 'hidden' },
  iconRowLarge: { flexDirection: 'row', width: '100%', marginTop: 8 },
  iconSelectLarge: { flex: 1, height: 64, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: '#eee' },
  moreButtonLarge: { flex: 1, backgroundColor: '#edf5ff' },
  moreText: { fontSize: 12, color: '#007aff' },
  moreIconsGrid: { flexDirection: 'column', paddingBottom: 12, width: '100%' },
  expiredText: { color: '#ff4d4f', marginTop: 4, fontSize: 12, fontWeight: '600' },
  expiryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  yearInput: { flex: 1, marginRight: 8 },
  pickerInput: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  modalOverlay: { flex:1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalContent: { width: 260, maxHeight: 360, backgroundColor: '#fff', borderRadius: 8, padding: 12 },
  noticeCard: { width: '100%', maxWidth: 340, backgroundColor: '#fff', borderRadius: 16, padding: 18, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 8 } },
  noticeTitle: { fontSize: 18, fontWeight: '700', color: '#12243b', marginBottom: 8 },
  noticeText: { fontSize: 15, lineHeight: 22, color: '#415267', marginBottom: 16 },
  noticeButton: { backgroundColor: '#1d74f5', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  noticeButtonText: { color: '#fff', fontWeight: '600' },
  confirmRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  cancelButton: { flex: 1, backgroundColor: '#5c6b7a' },
  modalTitle: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  modalItem: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#eee' },
  modalItemText: { fontSize: 16 },
  modalClose: { marginTop: 8, alignItems: 'center' },
  detailButtons: { flexDirection: 'row', marginTop: 20, justifyContent: 'center', alignItems: 'center' },
  editButton: { backgroundColor: '#2ecc71', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, marginRight: 12, minWidth: 100, alignItems: 'center' },
  editButtonText: { color: '#fff' },
  iconBg: { width: 56, height: 56, backgroundColor: '#fff', borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 28 },
  itemName: { marginTop: 6, fontSize: 12, color: '#000' },
  itemExpiry: { fontSize: 11, color: '#666' },
  empty: { padding: 20, color: '#666' },
  form: { padding: 16 },
  label: { fontSize: 14, color: '#000', marginTop: 12 },
  input: { borderWidth: 1, borderColor: '#ddd', padding: 8, marginTop: 6, borderRadius: 6, backgroundColor: '#fff', color: '#1d2a39', fontSize: 16 },
  pickerText: { color: '#1d2a39', fontSize: 16 },
  iconRow: { flexDirection: 'row', marginTop: 8, width: '100%' },
  iconSelect: { flex: 1, height: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: 8, backgroundColor: '#fff', borderWidth: 1, borderColor: '#eee' },
  iconSelected: { borderColor: '#007aff', borderWidth: 2 },
  saveButton: { backgroundColor: '#007aff', padding: 12, borderRadius: 8, marginTop: 20, alignItems: 'center' },
  saveButtonText: { color: '#fff', fontSize: 16 },
  close: { fontSize: 22 },
  detail: { alignItems: 'center', padding: 16 },
  iconBgLarge: { width: 120, height: 120, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 4, backgroundColor: '#fff' },
  iconTextLarge: { fontSize: 64 },
  detailName: { fontSize: 20, marginTop: 12 },
  detailExpiry: { color: '#666', marginTop: 6 },
  deleteButton: { backgroundColor: '#ff4d4f', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, minWidth: 100, alignItems: 'center' },
  deleteButtonText: { color: '#fff' },
});
