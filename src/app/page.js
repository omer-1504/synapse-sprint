'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { motion, AnimatePresence } from 'framer-motion';
import { Target, Trophy, Flame, AlertCircle, Menu } from 'lucide-react';

const ADJECTIVES = ['Alpha', 'Neuro', 'Synapse', 'Cortex', 'Quantum', 'Logic'];
const NOUNS = ['Thinker', 'Sage', 'Solver', 'Dynamo', 'Brain', 'Vector'];

// Muted, desaturated, non-vibrant, non-radium colors matching the 2048 palette aesthetic
const COLORS = [
  '#4E5E50', // Muted Forest/Sage
  '#A08C75', // Warm Sand/Taupe
  '#A3704C', // Terracotta/Clay
  '#5B6E7A', // Muted Slate/Steel
  '#8F754E', // Muted Ochre/Gold
  '#5C5046', // Dark Brown
];

export default function BrainGridGame() {
  const [tiles, setTiles] = useState([]);
  const [gameState, setGameState] = useState({ current_target: 1 });
  const [user, setUser] = useState({ name: '', color: '' });
  const [score, setScore] = useState(0);
  const [errorFlash, setErrorFlash] = useState(null);
  const [gridSize, setGridSize] = useState(10);
  const [isResetting, setIsResetting] = useState(false);

  // Fetch match data helper
  const pullInitialMatchData = async () => {
    const { data: tilesData } = await supabase.from('brain_tiles').select('*').order('id', { ascending: true });
    const { data: gameData } = await supabase.from('brain_game').select('*').eq('id', 1).single();
    
    if (tilesData) setTiles(tilesData);
    if (gameData) setGameState(gameData);
  };

  // Initialize identity and board state configuration
  useEffect(() => {
    let storedName = null;
    let storedColor = null;
    try {
      storedName = localStorage.getItem('synapse_name');
      storedColor = localStorage.getItem('synapse_color');
    } catch (e) {
      console.error(e);
    }

    if (!storedName) {
      storedName = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
      try {
        localStorage.setItem('synapse_name', storedName);
      } catch (e) {}
    }
    if (!storedColor) {
      storedColor = COLORS[Math.floor(Math.random() * COLORS.length)];
      try {
        localStorage.setItem('synapse_color', storedColor);
      } catch (e) {}
    }

    setUser({ name: storedName, color: storedColor });
    pullInitialMatchData();
  }, []);

  // Handle Real-time WebSocket Synchronizations
  useEffect(() => {
    const systemChannel = supabase
      .channel('realtime-brain-sync')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'brain_tiles' }, (payload) => {
        setTiles((prev) => prev.map((t) => (t.id === payload.new.id ? payload.new : t)));
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'brain_tiles' }, () => {
        pullInitialMatchData();
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'brain_tiles' }, () => {
        pullInitialMatchData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brain_game' }, (payload) => {
        if (payload.new) setGameState(payload.new);
        else pullInitialMatchData();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(systemChannel);
    };
  }, []);

  // Process Tile Interaction & Handle Conflicts
  const handleTileSelection = async (tile) => {
    // Return early if tile is claimed or incorrect or game is finished
    if (tile.owner_color || gameState.current_target > tiles.length) return;

    if (tile.value !== gameState.current_target) {
      setErrorFlash(tile.id);
      setTimeout(() => setErrorFlash(null), 600);
      return;
    }

    const nextTargetValue = gameState.current_target + 1;

    // Optimistic UI updates to provide instant local execution feel
    setTiles((prev) => prev.map((t) => t.id === tile.id ? { ...t, owner_name: user.name, owner_color: user.color } : t));
    setGameState((prev) => ({ ...prev, current_target: nextTargetValue }));
    setScore((prev) => prev + 10);

    // Write to DB sequentially.
    const { error: tileErr } = await supabase
      .from('brain_tiles')
      .update({ owner_name: user.name, owner_color: user.color })
      .eq('id', tile.id)
      .is('owner_color', null);

    const { error: gameErr } = await supabase
      .from('brain_game')
      .update({ current_target: nextTargetValue })
      .eq('id', 1)
      .eq('current_target', gameState.current_target);

    // Rollback changes if a race condition collision occurred with another user
    if (tileErr || gameErr) {
      await pullInitialMatchData();
      setScore((prev) => Math.max(0, prev - 10));
    }
  };

  // Reset the game and start fresh with a selected grid size
  const handleStartFreshGame = async (size) => {
    setIsResetting(true);
    try {
      // 1. Wipe all existing tiles
      await supabase
        .from('brain_tiles')
        .delete()
        .neq('id', 0);

      // 2. Generate new math tiles
      const totalTiles = size * size;
      const newTiles = [];
      for (let v = 1; v <= totalTiles; v++) {
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
        newTiles.push({ value: v, expression: expr });
      }

      // Shuffle tiles so they are not sequential on the grid
      const shuffledTiles = newTiles
        .map((value) => ({ value, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ value }) => value);

      // 3. Bulk insert tiles
      await supabase
        .from('brain_tiles')
        .insert(shuffledTiles);

      // 4. Reset target to 1
      await supabase
        .from('brain_game')
        .update({ current_target: 1 })
        .eq('id', 1);

      // Refresh locally
      await pullInitialMatchData();
    } catch (err) {
      console.error('Failed to reset game:', err);
    } finally {
      setIsResetting(false);
    }
  };

  // Compile realtime stats rankings
  const leaderboard = useMemo(() => {
    const tracking = {};
    tiles.forEach((t) => {
      if (t.owner_color) {
        tracking[t.owner_color] = {
          color: t.owner_color,
          name: t.owner_name,
          count: (tracking[t.owner_color]?.count || 0) + 1,
        };
      }
    });
    return Object.values(tracking).sort((a, b) => b.count - a.count).slice(0, 4);
  }, [tiles]);

  // Determine the winner
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

  // Track the high score locally
  const bestScore = useMemo(() => {
    let storedBest = 0;
    try {
      storedBest = Number(localStorage.getItem('synapse_best_score') || 0);
    } catch (e) {}
    const currentBest = Math.max(score, ...leaderboard.map(team => team.count * 10), 0);
    if (currentBest > storedBest) {
      try {
        localStorage.setItem('synapse_best_score', currentBest);
      } catch (e) {}
      return currentBest;
    }
    return storedBest;
  }, [score, leaderboard]);

  // Compile grid size grid columns class statically to ensure compilation
  const gridColsClass = {
    5: 'grid-cols-5',
    6: 'grid-cols-6',
    7: 'grid-cols-7',
    8: 'grid-cols-8',
    9: 'grid-cols-9',
    10: 'grid-cols-10',
  }[Math.sqrt(tiles.length)] || 'grid-cols-10';

  return (
    <div className="min-h-screen bg-background text-[#776e65] flex flex-col items-center p-4 md:p-6 font-sans select-none selection:bg-transparent">
      
      {/* 2048-Style Top Row Header */}
      <header className="w-full max-w-2xl flex justify-between items-center gap-4 mb-4">
        <div className="flex items-center gap-3">
          <Menu className="w-8 h-8 text-[#776e65] cursor-pointer" />
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-[#776e65]">
            Synapse
          </h1>
        </div>

        {/* 2048 scoring pill cards */}
        <div className="flex gap-2">
          {/* Target Pill */}
          <div className="bg-[#bbada0] rounded px-3 py-1 text-center min-w-[70px]">
            <div className="text-[9px] font-bold text-[#eee4da] uppercase tracking-wider">Target</div>
            <div className="text-lg font-bold text-white">
              {gameState.current_target <= tiles.length ? gameState.current_target : 'Done'}
            </div>
          </div>

          {/* Score Pill */}
          <div className="bg-[#bbada0] rounded px-3 py-1 text-center min-w-[70px]">
            <div className="text-[9px] font-bold text-[#eee4da] uppercase tracking-wider">Score</div>
            <div className="text-lg font-bold text-white">{score}</div>
          </div>

          {/* Best Pill */}
          <div className="bg-[#bbada0] rounded px-3 py-1 text-center min-w-[70px]">
            <div className="text-[9px] font-bold text-[#eee4da] uppercase tracking-wider">Best</div>
            <div className="text-lg font-bold text-white">{bestScore}</div>
          </div>
        </div>
      </header>

      {/* Subheader and Controls Row */}
      <div className="w-full max-w-2xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div>
          <p className="text-sm font-medium text-[#776e65]/90">
            Identify equations matching target. Grid size:
          </p>
          <p className="text-xs font-mono text-[#776e65]/70 mt-1">
            Identity: <span className="font-bold underline" style={{ color: user.color }}>{user.name}</span>
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Grid Size Select Dropdown */}
          <div className="bg-[#8f7a66] text-white rounded font-bold px-3 py-2 text-xs flex items-center gap-2 cursor-pointer transition-colors duration-150 hover:bg-[#8f7a66]/90">
            <span className="uppercase text-[9px] tracking-wider text-[#f9f6f2]/80">Grid:</span>
            <select
              value={gridSize}
              onChange={(e) => setGridSize(Number(e.target.value))}
              disabled={isFinished}
              className="bg-transparent font-bold text-white focus:outline-none cursor-pointer border-none outline-none appearance-none pr-1"
            >
              {[5, 6, 7, 8, 9, 10].map(s => (
                <option key={s} value={s} className="bg-[#8f7a66] text-white">
                  {s}x{s}
                </option>
              ))}
            </select>
          </div>

          {/* New Game Button */}
          <button
            onClick={() => handleStartFreshGame(gridSize)}
            disabled={isResetting}
            className="bg-[#8f7a66] text-[#f9f6f2] rounded font-bold px-4 py-2 text-xs transition-colors duration-150 hover:bg-[#8f7a66]/90"
          >
            {isResetting ? 'Resetting...' : 'New Game'}
          </button>
        </div>
      </div>

      {/* Main Container: Board Grid and Side Panels */}
      <div className="w-full max-w-2xl flex flex-col gap-6">
        
        {/* 2048-style board grid container */}
        <div className="w-full bg-[#bbada0] rounded-xl p-3">
          <div className={`grid ${gridColsClass} gap-2`}>
            {tiles.map((tile) => {
              const isError = errorFlash === tile.id;
              return (
                <motion.button
                  key={tile.id}
                  onClick={() => handleTileSelection(tile)}
                  disabled={tile.owner_color !== null || gameState.current_target > tiles.length}
                  animate={isError ? { x: [-4, 4, -4, 4, 0] } : {}}
                  transition={{ duration: 0.3 }}
                  whileHover={{ scale: tile.owner_color ? 1 : 1.04 }}
                  whileTap={{ scale: 0.98 }}
                  className="aspect-square w-full rounded flex flex-col items-center justify-center p-1 relative transition-all group overflow-hidden cursor-pointer"
                  style={{
                    backgroundColor: tile.owner_color ? '#eee4da' : isError ? '#f2b179' : '#cdc1b4',
                    border: tile.owner_color ? `2.5px solid ${tile.owner_color}` : 'none',
                    opacity: tile.owner_color ? 0.95 : 1,
                  }}
                >
                  {tile.owner_color ? (
                    // Captured Block Layout matching 2048 styling but indicating faction
                    <div className="flex flex-col items-center justify-center">
                      <span className="text-base md:text-lg font-bold" style={{ color: tile.owner_color }}>
                        {tile.value}
                      </span>
                      <span className="text-[8px] font-bold opacity-80 uppercase tracking-tighter truncate max-w-[50px]" style={{ color: tile.owner_color }}>
                        {tile.owner_name.split(' ')[0]}
                      </span>
                    </div>
                  ) : (
                    // Active Expression Layout
                    <span className="text-[10px] md:text-xs font-bold text-[#776e65] group-hover:text-white transition-colors">
                      {tile.expression}
                    </span>
                  )}
                </motion.button>
              );
            })}
          </div>
        </div>

        {/* Faction Leaderboard list */}
        <div className="bg-[#eee4da] rounded-xl p-4 border border-[#bbada0]/20">
          <h3 className="text-xs font-bold tracking-widest uppercase text-[#776e65]/80 flex items-center gap-2 mb-3 border-b border-[#776e65]/10 pb-1.5">
            <Trophy className="w-4 h-4 text-[#776e65]" /> Faction Rankings
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {leaderboard.map((team, index) => (
              <motion.div
                key={team.color}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center justify-between p-2.5 rounded bg-background border border-[#bbada0]/30"
              >
                <div className="flex items-center gap-2 overflow-hidden">
                  <span className="text-[10px] font-bold text-[#776e65]/50">#{index + 1}</span>
                  <div className="h-2.5 w-2.5 rounded-none" style={{ backgroundColor: team.color }} />
                  <span className="text-[10px] font-bold truncate" style={{ color: team.color }}>
                    {team.name.split(' ')[0]}
                  </span>
                </div>
                <span className="text-[10px] font-bold bg-[#bbada0] text-white px-1.5 py-0.5 rounded">
                  {team.count}
                </span>
              </motion.div>
            ))}
            {leaderboard.length === 0 && (
              <div className="col-span-4 text-center py-4 text-xs text-[#776e65]/50 italic">
                Solve the formulas in sequential target order!
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 2048-style Game Over / Sprint Complete Modal Overlay */}
      {isFinished && (
        <div className="fixed inset-0 bg-[#faf8ef]/90 flex items-center justify-center z-50 p-4">
          <div className="bg-[#eee4da] rounded-xl border border-[#bbada0]/30 max-w-sm w-full p-8 text-center flex flex-col items-center gap-5">
            <h2 className="text-4xl font-bold tracking-tight text-[#776e65]">
              Sprint Over!
            </h2>
            <div className="w-full h-0.5 bg-[#bbada0]/30" />
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-[#776e65]/60">Winner Faction</span>
              <span className="text-2xl font-bold" style={{ color: winner?.color }}>
                {winner?.name || 'No Claims'}
              </span>
              <span className="text-xs font-medium text-[#776e65]/80">
                Claimed {winner?.count || 0} of {tiles.length} cells
              </span>
            </div>
            <button
              onClick={() => handleStartFreshGame(gridSize)}
              disabled={isResetting}
              className="w-full bg-[#8f7a66] text-[#f9f6f2] rounded font-bold py-3.5 text-xs transition-colors duration-150 hover:bg-[#8f7a66]/90"
            >
              {isResetting ? 'Setting up next board...' : 'OK'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

