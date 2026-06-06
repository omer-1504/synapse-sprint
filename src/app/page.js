'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { motion, AnimatePresence } from 'framer-motion';
import { Target, Trophy, AlertCircle, User, Terminal, Play, CheckCircle2 } from 'lucide-react';

const COLORS = [
  { hex: '#4E5E50', name: 'Forest Sage' },
  { hex: '#A08C75', name: 'Sand Taupe' },
  { hex: '#A3704C', name: 'Clay Clay' },
  { hex: '#5B6E7A', name: 'Slate Steel' },
  { hex: '#8F754E', name: 'Gold Ochre' },
  { hex: '#5C5046', name: 'Dark Brown' },
];

export default function BrainGridGame() {
  const [hasJoined, setHasJoined] = useState(false);
  const [joinName, setJoinName] = useState('');
  const [selectedColor, setSelectedColor] = useState(COLORS[0].hex);
  const [joinError, setJoinError] = useState(null);

  const [tiles, setTiles] = useState([]);
  const [gameState, setGameState] = useState({ current_target: 1 });
  const [user, setUser] = useState({ name: '', color: '' });
  const [score, setScore] = useState(0);
  const [errorFlash, setErrorFlash] = useState(null);
  const [wsLogs, setWsLogs] = useState([]);
  const [isResetting, setIsResetting] = useState(false);

  // Generate a unique client ID to prevent self-processing loop
  const clientId = useMemo(() => Math.random().toString(36).substring(2, 9), []);

  // Track refs to prevent closure staleness in the WebSocket callback
  const tilesRef = useRef(tiles);
  const gameStateRef = useRef(gameState);

  useEffect(() => {
    tilesRef.current = tiles;
  }, [tiles]);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  // Logger helper for WebSockets
  const logWs = (dir, event, payload) => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    setWsLogs((prev) => [
      { id: Math.random().toString(), time, dir, event, payload },
      ...prev.slice(0, 49)
    ]);
  };

  // Pull initial match data from Supabase
  const pullInitialMatchData = async () => {
    try {
      const { data: tilesData, error: tilesErr } = await supabase
        .from('brain_tiles')
        .select('*')
        .order('id', { ascending: true });
      const { data: gameData, error: gameErr } = await supabase
        .from('brain_game')
        .select('*')
        .eq('id', 1)
        .single();

      if (tilesErr || gameErr || !tilesData) {
        return null;
      }
      setTiles(tilesData);
      setGameState(gameData);
      return { tiles: tilesData, game: gameData };
    } catch (e) {
      return null;
    }
  };

  // Pre-fill fields from localStorage if they exist
  useEffect(() => {
    try {
      const storedName = localStorage.getItem('synapse_name');
      const storedColor = localStorage.getItem('synapse_color');
      if (storedName) setJoinName(storedName);
      if (storedColor) setSelectedColor(storedColor);
    } catch (e) {
      console.error(e);
    }
  }, []);

  // Initialize Game Board state on join
  useEffect(() => {
    if (!hasJoined) return;

    const initGameBoard = async () => {
      // 1. Try to load from Supabase DB
      const dbData = await pullInitialMatchData();
      if (dbData) {
        logWs('SYSTEM', 'db_sync_ok', { tilesCount: dbData.tiles.length });
        
        // If the database game is already finished or stale (target is 1 but has captures), immediately start a fresh game
        const capturedCount = dbData.tiles.filter(t => t.owner_color !== null).length;
        const isDbGameFinished = dbData.tiles.length > 0 && dbData.game.current_target > dbData.tiles.length;
        const isDbGameStale = (dbData.game.current_target === 1 && capturedCount > 0);

        if (isDbGameFinished || isDbGameStale) {
          logWs('SYSTEM', 'db_game_finished_auto_reset', { info: 'Last database game was completed or stale, starting new game' });
          await handleStartFreshGame();
        }
        return;
      }

      // 2. Fall back to waiting for sync-response or generate new local board after 1.5s
      setTimeout(() => {
        setTiles((currentTiles) => {
          if (currentTiles.length > 0) return currentTiles; // State already synced

          logWs('SYSTEM', 'local_init', { info: 'No DB or active room state, creating new board' });
          const freshTiles = [];
          for (let v = 1; v <= 100; v++) {
            let r = Math.floor(Math.random() * 10 + 1);
            let expr = '';
            if (Math.random() > 0.5) {
              expr = `${v + r} - ${r}`;
            } else {
              r = Math.floor(Math.random() * (v - 1) + 1);
              if (v === 1) {
                expr = '5 - 4';
              } else {
                expr = `${v - r} + ${r}`;
              }
            }
            freshTiles.push({ id: v, value: v, expression: expr, owner_name: null, owner_color: null });
          }
          
          // Shuffle tiles so they are not sequential on the grid
          const shuffledTiles = freshTiles
            .map((value) => ({ value, sort: Math.random() }))
            .sort((a, b) => a.sort - b.sort)
            .map(({ value }) => value);

          return shuffledTiles;
        });
      }, 1500);
    };

    initGameBoard();
  }, [hasJoined]);

  // Setup Real-time WebSockets & Local BroadcastChannel integrations
  useEffect(() => {
    if (!user.name) return;

    // 1. Setup Local BroadcastChannel fallback
    let localBC = null;
    try {
      localBC = new BroadcastChannel('synapse_sprint_room');
    } catch (e) {
      console.error('BroadcastChannel not supported', e);
    }

    // 2. Setup Supabase Realtime Channel
    const roomChannel = supabase.channel('synapse-sprint-room', {
      config: {
        broadcast: { self: false },
      },
    });

    // Unified message processor
    const handleIncomingMessage = (event, payload) => {
      if (payload.clientId === clientId) return;

      logWs('RECV', event, payload);

      if (event === 'sync-request') {
        // Active tabs send current board configuration to new player
        if (tilesRef.current.length > 0 && window.__gameChannelSend) {
          window.__gameChannelSend('sync-response', {
            tiles: tilesRef.current,
            current_target: gameStateRef.current.current_target,
          });
        }
      } else if (event === 'sync-response') {
        const isResponseFinished = payload.tiles.length > 0 && payload.current_target > payload.tiles.length;
        if (isResponseFinished) {
          logWs('SYSTEM', 'sync_game_finished_auto_reset', { info: 'Synced game was completed, starting new game' });
          handleStartFreshGame();
        } else {
          setTiles(payload.tiles);
          setGameState({ current_target: payload.current_target });
        }
      } else if (event === 'tile-selected') {
        setTiles((prev) =>
          prev.map((t) =>
            t.value === payload.tileValue
              ? { ...t, owner_name: payload.owner_name, owner_color: payload.owner_color }
              : t
          )
        );
        setGameState({ current_target: payload.next_target });
      } else if (event === 'new-game') {
        setTiles(payload.tiles);
        setGameState({ current_target: 1 });
        setScore(0);
      }
    };

    if (localBC) {
      localBC.onmessage = (msgEvent) => {
        const { event, payload } = msgEvent.data;
        handleIncomingMessage(event, payload);
      };
    }

    roomChannel
      .on('broadcast', { event: 'sync-request' }, ({ payload }) => handleIncomingMessage('sync-request', payload))
      .on('broadcast', { event: 'sync-response' }, ({ payload }) => handleIncomingMessage('sync-response', payload))
      .on('broadcast', { event: 'tile-selected' }, ({ payload }) => handleIncomingMessage('tile-selected', payload))
      .on('broadcast', { event: 'new-game' }, ({ payload }) => handleIncomingMessage('new-game', payload))
      .subscribe((status) => {
        logWs('SYSTEM', 'supabase_status', { status });
      });

    // Save send helper in ref
    window.__gameChannelSend = (event, payload) => {
      payload.clientId = clientId;
      logWs('SEND', event, payload);

      roomChannel.send({
        type: 'broadcast',
        event,
        payload,
      });

      if (localBC) {
        localBC.postMessage({ event, payload });
      }
    };

    // Request sync from existing tabs
    setTimeout(() => {
      if (window.__gameChannelSend) {
        window.__gameChannelSend('sync-request', { sender: user.name });
      }
    }, 500);

    return () => {
      supabase.removeChannel(roomChannel);
      if (localBC) {
        localBC.close();
      }
      delete window.__gameChannelSend;
    };
  }, [user.name, clientId]);

  // Handle Form Submission
  const handleJoinSubmit = () => {
    if (!joinName.trim()) {
      setJoinError('Please enter a username.');
      return;
    }
    const cleanName = joinName.trim();
    try {
      localStorage.setItem('synapse_name', cleanName);
      localStorage.setItem('synapse_color', selectedColor);
    } catch (e) {}

    setUser({ name: cleanName, color: selectedColor });
    setHasJoined(true);
  };

  // Process Tile Selection
  const handleTileSelection = (tile) => {
    if (tile.owner_color || gameState.current_target > tiles.length) return;

    if (tile.value !== gameState.current_target) {
      setErrorFlash(tile.id);
      setTimeout(() => setErrorFlash(null), 600);
      return;
    }

    const nextTargetValue = gameState.current_target + 1;

    // Apply change locally
    setTiles((prev) =>
      prev.map((t) =>
        t.value === tile.value ? { ...t, owner_name: user.name, owner_color: user.color } : t
      )
    );
    setGameState({ current_target: nextTargetValue });
    setScore((prev) => prev + 10);

    // Sync via WebSockets
    if (window.__gameChannelSend) {
      window.__gameChannelSend('tile-selected', {
        tileValue: tile.value,
        owner_name: user.name,
        owner_color: user.color,
        next_target: nextTargetValue,
      });
    }

    // Persist to Supabase DB in background (ignore errors)
    try {
      supabase
        .from('brain_tiles')
        .update({ owner_name: user.name, owner_color: user.color })
        .eq('id', tile.id)
        .then(() => {});

      supabase
        .from('brain_game')
        .update({ current_target: nextTargetValue })
        .eq('id', 1)
        .then(() => {});
    } catch (e) {
      console.warn("Could not persist tile claim to DB in background", e);
    }
  };

  // Start fresh game synchronized via WebSockets
  const handleStartFreshGame = async () => {
    setIsResetting(true);
    try {
      const freshTiles = [];
      for (let v = 1; v <= 100; v++) {
        let r = Math.floor(Math.random() * 10 + 1);
        let expr = '';
        if (Math.random() > 0.5) {
          expr = `${v + r} - ${r}`;
        } else {
          r = Math.floor(Math.random() * (v - 1) + 1);
          if (v === 1) {
            expr = '5 - 4';
          } else {
            expr = `${v - r} + ${r}`;
          }
        }
        freshTiles.push({ value: v, expression: expr, owner_name: null, owner_color: null });
      }

      // Shuffle and map to local shape with local IDs
      const shuffledTiles = freshTiles
        .map((value) => ({ value, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ value }, index) => ({
          id: index + 1,
          value: value.value,
          expression: value.expression,
          owner_name: null,
          owner_color: null
        }));

      setTiles(shuffledTiles);
      setGameState({ current_target: 1 });
      setScore(0);

      // Broadcast fresh board
      if (window.__gameChannelSend) {
        window.__gameChannelSend('new-game', {
          tiles: shuffledTiles,
        });
      }

      // Persist to Supabase DB in background (wipe and insert fresh tiles, with direct update fallback)
      try {
        supabase
          .from('brain_tiles')
          .delete()
          .neq('id', 0)
          .then(() => {
            const dbTiles = shuffledTiles.map(t => ({
              value: t.value,
              expression: t.expression,
              owner_name: null,
              owner_color: null
            }));

            supabase
              .from('brain_tiles')
              .insert(dbTiles)
              .then(() => {
                supabase
                  .from('brain_game')
                  .update({ current_target: 1 })
                  .eq('id', 1)
                  .then(() => {});
              })
              .catch(e => console.warn("Background insert failed", e));
          })
          .catch(e => {
            // Failsafe: if delete fails, clear owners on the existing rows instead of recreating them
            console.warn("Delete failed, running direct owner clear update instead", e);
            supabase
              .from('brain_tiles')
              .update({ owner_name: null, owner_color: null })
              .neq('id', 0)
              .then(() => {
                supabase
                  .from('brain_game')
                  .update({ current_target: 1 })
                  .eq('id', 1)
                  .then(() => {});
              })
              .catch(err => console.warn("Failsafe update failed", err));
          });
      } catch (dbErr) {
        console.warn("Could not reset DB game state in background", dbErr);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsResetting(false);
    }
  };

  // Leaderboard statistics calculations
  const leaderboard = useMemo(() => {
    const tracking = {};
    COLORS.forEach((col) => {
      tracking[col.hex] = {
        color: col.hex,
        name: col.name,
        count: 0,
      };
    });

    tiles.forEach((t) => {
      if (t.owner_color && tracking[t.owner_color]) {
        tracking[t.owner_color].count += 1;
        tracking[t.owner_color].name = t.owner_name;
      }
    });

    return Object.values(tracking).sort((a, b) => b.count - a.count);
  }, [tiles]);

  // Determine winner when target reaches finished state
  const winner = useMemo(() => {
    if (tiles.length === 0 || gameState.current_target <= tiles.length) return null;
    const tracking = {};
    tiles.forEach((t) => {
      if (t.owner_name) {
        tracking[t.owner_name] = {
          name: t.owner_name,
          color: t.owner_color,
          count: (tracking[t.owner_name]?.count || 0) + 1
        };
      }
    });
    const sorted = Object.values(tracking).sort((a, b) => b.count - a.count);
    return sorted[0] || null;
  }, [tiles, gameState.current_target]);

  const isFinished = tiles.length > 0 && gameState.current_target > tiles.length;

  if (!hasJoined) {
    return (
      <div className="min-h-screen bg-[#faf8ef] flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#eee4da] rounded-xl border border-[#bbada0]/30 max-w-md w-full p-8 shadow-xl text-center flex flex-col gap-6 font-sans select-none"
        >
          <div className="flex flex-col items-center gap-2">
            <div className="w-16 h-16 bg-[#bbada0] rounded-full flex items-center justify-center shadow-inner">
              <Target className="w-10 h-10 text-[#faf8ef]" />
            </div>
            <h1 className="text-4xl font-extrabold text-[#776e65] mt-2 tracking-tight">
              Synapse Sprint
            </h1>
            <p className="text-xs text-[#776e65]/80 font-medium">
              Join the real-time math-equation speed competition!
            </p>
          </div>

          <div className="flex flex-col gap-4 text-left">
            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-[#776e65]/70 block mb-1.5 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5" /> Your Username
              </label>
              <input
                type="text"
                placeholder="Enter name (e.g. Brainiac)"
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                maxLength={20}
                className="w-full bg-[#faf8ef] text-[#776e65] font-bold rounded-lg border border-[#bbada0] px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#8f7a66] transition-all"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-wider text-[#776e65]/70 block mb-2">
                Choose Faction Color
              </label>
              <div className="grid grid-cols-3 gap-3">
                {COLORS.map((col) => {
                  const isSelected = selectedColor === col.hex;
                  return (
                    <button
                      key={col.hex}
                      type="button"
                      onClick={() => setSelectedColor(col.hex)}
                      className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-all cursor-pointer ${
                        isSelected 
                          ? 'bg-white border-[#8f7a66] shadow-sm scale-105' 
                          : 'bg-[#faf8ef]/60 border-[#bbada0]/40 hover:bg-[#faf8ef]'
                      }`}
                    >
                      <div 
                        className="w-8 h-8 rounded-full border border-black/10 flex items-center justify-center" 
                        style={{ backgroundColor: col.hex }}
                      >
                        {isSelected && <CheckCircle2 className="w-4 h-4 text-white drop-shadow-sm" />}
                      </div>
                      <span className="text-[9px] font-bold text-[#776e65] opacity-90 truncate max-w-full">
                        {col.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {joinError && (
            <div className="text-xs text-rose-500 font-bold bg-rose-50 p-2 rounded flex items-center gap-1 justify-center">
              <AlertCircle className="w-4 h-4" /> {joinError}
            </div>
          )}

          <button
            onClick={handleJoinSubmit}
            className="w-full bg-[#8f7a66] hover:bg-[#7a6857] text-[#f9f6f2] rounded-lg font-bold py-3.5 text-sm transition-all duration-150 flex items-center justify-center gap-2 shadow-md cursor-pointer hover:shadow-lg"
          >
            <Play className="w-4 h-4 fill-current" /> Join Sprint
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-[#776e65] flex flex-col items-center p-4 md:p-6 font-sans select-none selection:bg-transparent">
      
      {/* Header Container */}
      <header className="w-full max-w-7xl flex justify-between items-center gap-4 mb-6">
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-[#776e65]">
          Synapse Sprint
        </h1>

        {/* Target and Score pills */}
        <div className="flex gap-2">
          {/* Target Pill */}
          <div className="bg-[#bbada0] rounded px-4 py-1.5 text-center min-w-[85px]">
            <div className="text-[9px] font-bold text-[#eee4da] uppercase tracking-wider">Target</div>
            <div className="text-lg font-bold text-white">
              {gameState.current_target <= tiles.length ? gameState.current_target : 'Done'}
            </div>
          </div>

          {/* Score Pill */}
          <div className="bg-[#bbada0] rounded px-4 py-1.5 text-center min-w-[85px]">
            <div className="text-[9px] font-bold text-[#eee4da] uppercase tracking-wider">Score</div>
            <div className="text-lg font-bold text-white">{score}</div>
          </div>
        </div>
      </header>

      {/* Subheader and controls */}
      <div className="w-full max-w-7xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 border-b border-[#bbada0]/20 pb-4">
        <div>
          <p className="text-sm font-semibold text-[#776e65]/90">
            Identify equations matching target.
          </p>
          <p className="text-xs font-mono text-[#776e65]/70 mt-1 flex items-center gap-1.5">
            Identity: <span className="font-bold underline" style={{ color: user.color }}>{user.name}</span>
          </p>
        </div>

        {/* New Game Button */}
        <button
          onClick={handleStartFreshGame}
          disabled={isResetting}
          className="bg-[#8f7a66] text-[#f9f6f2] rounded font-bold px-5 py-2.5 text-xs transition-all duration-150 hover:bg-[#8f7a66]/90 cursor-pointer shadow-sm hover:shadow"
        >
          {isResetting ? 'Resetting...' : 'New Game'}
        </button>
      </div>

      {/* Main 3-Column Dashboard Layout */}
      <div className="w-full max-w-7xl grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* Left Column: WebSocket Call Log console */}
        <div className="lg:col-span-3 bg-[#3a3530] text-[#f9f6f2] font-mono p-4 rounded-xl shadow-lg border border-[#bbada0]/40 h-[520px] flex flex-col gap-3">
          <div className="flex items-center justify-between border-b border-[#bbada0]/20 pb-2">
            <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-2 text-[#eee4da]">
              <Terminal className="w-4 h-4 text-emerald-400" /> WebSocket Console
            </h3>
            <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-ping shrink-0" />
              LIVE
            </div>
          </div>

          {/* Log List */}
          <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 scrollbar-thin scrollbar-thumb-stone-600">
            {wsLogs.map((log) => (
              <div key={log.id} className="text-[10px] leading-relaxed border-b border-[#bbada0]/10 pb-1.5 flex flex-col gap-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-[#a08c75]">{log.time}</span>
                  <span className={
                    log.dir === 'SEND' ? 'text-emerald-400 font-bold' : 
                    log.dir === 'RECV' ? 'text-amber-400 font-bold' : 
                    'text-sky-400 font-bold'
                  }>
                    [{log.dir}]
                  </span>
                </div>
                <div className="text-[#f9f6f2] font-semibold text-[10.5px]">{log.event}</div>
                <div className="text-[#cdc1b4] text-[9.5px] break-all font-light bg-[#2d2b28]/60 p-1 rounded mt-0.5">
                  {JSON.stringify(log.payload)}
                </div>
              </div>
            ))}
            {wsLogs.length === 0 && (
              <div className="text-center text-[#cdc1b4]/40 py-16 italic text-xs">
                Waiting for WebSocket frames...
              </div>
            )}
          </div>
        </div>

        {/* Center Column: Game Grid Board */}
        <div className="lg:col-span-6 bg-[#bbada0] rounded-xl p-3 shadow-lg">
          <div className="grid grid-cols-10 gap-1.5 sm:gap-2">
            {tiles.map((tile) => {
              const isError = errorFlash === tile.id;
              return (
                <motion.button
                  key={tile.id}
                  onClick={() => handleTileSelection(tile)}
                  disabled={tile.owner_color !== null || gameState.current_target > tiles.length}
                  animate={isError ? { x: [-4, 4, -4, 4, 0] } : {}}
                  transition={{ duration: 0.3 }}
                  whileHover={{ scale: tile.owner_color ? 1 : 1.05 }}
                  whileTap={{ scale: 0.98 }}
                  className="aspect-square w-full rounded flex flex-col items-center justify-center p-0.5 relative transition-all group overflow-hidden cursor-pointer"
                  style={{
                    backgroundColor: tile.owner_color ? '#eee4da' : isError ? '#f2b179' : '#cdc1b4',
                    border: tile.owner_color ? `2px solid ${tile.owner_color}` : 'none',
                    opacity: tile.owner_color ? 0.95 : 1,
                  }}
                >
                  {tile.owner_color ? (
                    <div className="flex flex-col items-center justify-center">
                      <span className="text-[11px] sm:text-sm font-extrabold" style={{ color: tile.owner_color }}>
                        {tile.value}
                      </span>
                      <span className="text-[7px] font-bold opacity-80 uppercase tracking-tighter truncate max-w-[28px] sm:max-w-[40px]" style={{ color: tile.owner_color }}>
                        {tile.owner_name}
                      </span>
                    </div>
                  ) : (
                    <span className="text-[8px] sm:text-[10px] font-bold text-[#776e65] group-hover:text-white transition-colors">
                      {tile.expression}
                    </span>
                  )}
                </motion.button>
              );
            })}
          </div>
        </div>

        {/* Right Column: Faction Leaderboard rankings */}
        <div className="lg:col-span-3 bg-[#eee4da] rounded-xl p-4 border border-[#bbada0]/20 shadow-md flex flex-col gap-4">
          <h3 className="text-xs font-bold tracking-widest uppercase text-[#776e65]/80 flex items-center gap-2 border-b border-[#776e65]/10 pb-2">
            <Trophy className="w-4 h-4 text-[#776e65]" /> Faction Standings
          </h3>

          <div className="flex flex-col gap-3.5">
            {leaderboard.map((team, index) => {
              const percentage = (team.count / Math.max(tiles.length, 1)) * 100;
              return (
                <div key={team.color} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs font-bold">
                    <div className="flex items-center gap-2 overflow-hidden">
                      <span className="text-[10px] text-[#776e65]/50">#{index + 1}</span>
                      <div className="h-3 w-3 rounded-full border border-black/10 shrink-0" style={{ backgroundColor: team.color }} />
                      <span className="truncate text-[#776e65]" style={{ color: team.count > 0 ? team.color : undefined }}>
                        {team.count > 0 ? team.name : team.name.replace(' Faction', '')}
                      </span>
                    </div>
                    <span className="bg-[#bbada0] text-white px-2 py-0.5 rounded text-[10px]">
                      {team.count} pts
                    </span>
                  </div>
                  {/* Progress Bar */}
                  <div className="w-full h-1.5 bg-[#cdc1b4] rounded-full overflow-hidden">
                    <motion.div 
                      className="h-full rounded-full"
                      style={{ backgroundColor: team.color }}
                      animate={{ width: `${percentage}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>

      {/* Winner Completion Overlay Popup */}
      <AnimatePresence>
        {isFinished && (
          <div className="fixed inset-0 bg-[#faf8ef]/90 flex items-center justify-center z-50 p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-[#eee4da] rounded-xl border border-[#bbada0]/30 max-w-sm w-full p-8 shadow-2xl text-center flex flex-col items-center gap-5 font-sans"
            >
              <div className="w-16 h-16 bg-[#8f7a66] rounded-full flex items-center justify-center shadow-lg">
                <Trophy className="w-9 h-9 text-white animate-bounce" />
              </div>
              
              <h2 className="text-4xl font-extrabold tracking-tight text-[#776e65]">
                Sprint Complete!
              </h2>
              <div className="w-full h-0.5 bg-[#bbada0]/30" />
              
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#776e65]/60">Winner Faction</span>
                <span className="text-2xl font-extrabold" style={{ color: winner?.color }}>
                  {winner?.name || 'No Claims'}
                </span>
                <span className="text-xs font-semibold text-[#776e65]/80 bg-[#cdc1b4] px-3 py-1.5 rounded-full mt-2">
                  Claimed {winner?.count || 0} of {tiles.length} cells
                </span>
              </div>

              <button
                onClick={handleStartFreshGame}
                className="w-full bg-[#8f7a66] text-[#f9f6f2] hover:bg-[#7a6857] rounded-lg font-bold py-3.5 text-xs transition-all duration-150 cursor-pointer shadow-md"
              >
                OK
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

