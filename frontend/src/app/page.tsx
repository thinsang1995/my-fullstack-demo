"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
}

export default function Home() {
  const [title, setTitle] = useState("");
  const queryClient = useQueryClient();

  const { data: todos = [], isLoading } = useQuery<Todo[]>({
    queryKey: ["todos"],
    queryFn: () => api.get("/todos").then((res) => res.data),
  });

  const addMutation = useMutation({
    mutationFn: (title: string) => api.post("/todos", { title }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["todos"] });
      setTitle("");
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/todos/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["todos"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/todos/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["todos"] }),
  });

  const handleAdd = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    addMutation.mutate(trimmed);
  };

  return (
    <div className="flex min-h-screen items-start justify-center bg-zinc-50 pt-20 font-sans dark:bg-black">
      <main className="w-full max-w-lg px-4">
        <h1 className="mb-8 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          TODO List
        </h1>

        <div className="mb-6 flex gap-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="What needs to be done?"
            className="flex-1 rounded-lg border border-zinc-300 px-4 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
          <button
            onClick={handleAdd}
            disabled={addMutation.isPending}
            className="rounded-lg bg-zinc-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Add
          </button>
        </div>

        {isLoading ? (
          <p className="text-sm text-zinc-500">Loading...</p>
        ) : todos.length === 0 ? (
          <p className="text-sm text-zinc-500">No todos yet. Add one above!</p>
        ) : (
          <ul className="space-y-2">
            {todos.map((todo) => (
              <li
                key={todo.id}
                className="flex items-center gap-3 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800"
              >
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => toggleMutation.mutate(todo.id)}
                  className="h-4 w-4 accent-zinc-900 dark:accent-zinc-50"
                />
                <span
                  className={`flex-1 text-sm ${
                    todo.completed
                      ? "text-zinc-400 line-through"
                      : "text-zinc-900 dark:text-zinc-50"
                  }`}
                >
                  {todo.title}
                </span>
                <button
                  onClick={() => deleteMutation.mutate(todo.id)}
                  className="text-sm text-zinc-400 transition-colors hover:text-red-500"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
